// The websocket both shell pages hold open to the hub. It is the only wire
// between a browser and a session; everything it does is a call into Sessions.
//
// Client -> hub:  hello {role, code?, name?, device?} | rename {name}
//                 host only: launch {gameId} | close {} | end {}
// Hub -> client:  welcome | state (full snapshot on every change) | error
//                 | notice | bye
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Auth, RateLimiter } from "./auth.ts";
import { LobbyError, type Conn, type Member, type Session, type Sessions } from "./sessions.ts";

export interface LobbyOptions {
  sessions: Sessions;
  auth: Auth;
  joinLimiter: RateLimiter;
  joinUrl: (code: string) => string;
  clientIp: (req: IncomingMessage) => string;
  /** Kept under Cloudflare's ~100 s idle cutoff. */
  pingMs?: number;
}

interface Peer {
  session?: Session;
  role?: "host" | "player";
  member?: Member;
}

export class Lobby {
  #wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  #options: LobbyOptions;
  #alive = new WeakSet<WebSocket>();
  #ping: NodeJS.Timeout;

  constructor(options: LobbyOptions) {
    this.#options = options;
    this.#ping = setInterval(() => {
      for (const socket of this.#wss.clients) {
        // No pong since the last ping: the phone is asleep or gone.
        if (!this.#alive.has(socket)) {
          socket.terminate();
          continue;
        }
        this.#alive.delete(socket);
        socket.ping();
      }
    }, options.pingMs ?? 25_000);
    this.#ping.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, req));
  }

  close(): void {
    clearInterval(this.#ping);
    for (const socket of this.#wss.clients) socket.terminate();
    this.#wss.close();
  }

  #accept(ws: WebSocket, req: IncomingMessage): void {
    const { sessions, auth } = this.#options;
    const isHost = auth.isHost(req.headers.cookie);
    const ip = this.#options.clientIp(req);
    const peer: Peer = {};
    const conn: Conn = {
      send: (message) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      close: () => ws.close(1000),
    };
    const fail = (code: string, close = false) => {
      conn.send({ type: "error", code });
      if (close) ws.close(1008);
    };

    this.#alive.add(ws);
    ws.on("pong", () => this.#alive.add(ws));
    ws.on("error", () => {});
    // A connection that never says hello is not left hanging.
    const helloTimer = setTimeout(() => {
      if (!peer.session) ws.close(1008);
    }, 10_000);

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (peer.session) sessions.detach(peer.session, conn);
    });

    ws.on("message", (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data));
      } catch {
        return ws.close(1003);
      }
      if (!message || typeof message !== "object") return ws.close(1003);

      if (!peer.session) {
        if (message.type !== "hello") return ws.close(1008);
        if (message.role === "host") {
          if (!isHost) return fail("not_host", true);
          try {
            // Reattach after a refresh when the code is still live.
            peer.session = sessions.get(message.code) ?? sessions.create();
          } catch (error) {
            return fail(error instanceof LobbyError ? error.code : "error", true);
          }
          peer.role = "host";
          conn.send({
            type: "welcome",
            role: "host",
            code: peer.session.code,
            joinUrl: this.#options.joinUrl(peer.session.code),
          });
          sessions.attachHost(peer.session, conn);
          return;
        }

        // Wrong codes are counted per address, so codes cannot be guessed by
        // brute force. Successful joins are free: a whole party usually shares
        // one address.
        if (!this.#options.joinLimiter.allowed(ip)) return fail("rate_limited", true);
        const session = sessions.get(message.code);
        if (!session) {
          this.#options.joinLimiter.take(ip);
          return fail("bad_code", true);
        }
        let playerId = auth.verifyDevice(message.device);
        let device = message.device;
        if (!playerId) ({ playerId, token: device } = auth.issueDevice());
        try {
          // Sends this player their first state (which says who they are).
          peer.member = sessions.joinPlayer(session, playerId, message.name, conn);
        } catch (error) {
          return fail(error instanceof LobbyError ? error.code : "error", true);
        }
        peer.session = session;
        peer.role = "player";
        // The device token is what lets this phone reclaim its seat later.
        conn.send({ type: "welcome", role: "player", code: session.code, device });
        return;
      }

      const session = peer.session;
      if (peer.role === "player" && peer.member) {
        if (message.type === "rename") sessions.rename(session, peer.member, message.name);
        return;
      }
      if (peer.role !== "host") return;

      switch (message.type) {
        case "launch":
          sessions.launch(session, message.gameId).catch((error) => {
            fail(error instanceof LobbyError ? error.code : "game_failed");
          });
          break;
        case "close":
          void sessions.closeGame(session, "host");
          break;
        case "end":
          void sessions.end(session, "host");
          break;
      }
    });
  }
}
