// The one Colyseus room a game process serves.
//
// It turns Colyseus's connection lifecycle into the small Game API: seats are
// keyed by the hub's player id (not the socket), so a phone that refreshes or
// wakes up takes its seat back, and every change re-sends each recipient only
// their own view.
import { Room, ServerError, type Client } from "@colyseus/core";
import { verifyTicket, type TicketClaims } from "./ticket.ts";
import type { Game, GameDefinition, Player } from "./types.ts";

export interface RoomSettings {
  def: GameDefinition<any>;
  code: string;
  launchId: string;
  secret: string;
  maxPlayers: number;
}

/** Close code sent to a connection whose seat was taken over by a newer one. */
export const CLOSE_REPLACED = 4901;

let settings: RoomSettings | undefined;

/** Colyseus constructs the room itself, so configuration is handed over here. */
export function configureRoom(next: RoomSettings): void {
  settings = next;
}

/**
 * What a game sees of a player. Kept apart from the connection on purpose:
 * games put these straight into views, so they must hold nothing but data.
 */
interface PlayerRecord {
  id: string;
  name: string;
  connected: boolean;
}

interface Seat {
  player: PlayerRecord;
  client?: Client;
  /** JSON of the last view sent on the current connection. */
  lastView?: string;
}

interface Timer {
  handle: NodeJS.Timeout;
  at: number;
}

export class ArcadeRoom extends Room {
  #cfg!: RoomSettings;
  #host: Seat = { player: { id: "host", name: "Host", connected: false } };
  #seats = new Map<string, Seat>();
  /** Players in join order. This is the array games see as `players`. */
  #players: PlayerRecord[] = [];
  #timers = new Map<string, Timer>();
  #ended = false;
  #game!: Game<any>;

  onCreate(): void {
    if (!settings) throw new Error("ArcadeRoom used without serve()");
    this.#cfg = settings;
    this.roomId = this.#cfg.code;
    this.autoDispose = false; // lives as long as the process; the hub ends both
    this.maxMessagesPerSecond = 30;

    const room = this;
    const players = this.#players;
    const host = this.#host;
    this.#game = {
      state: undefined,
      code: this.#cfg.code,
      get players(): readonly Player[] {
        return players;
      },
      get hostConnected(): boolean {
        return host.player.connected;
      },
      timer: (name, ms, fn) => room.#setTimer(name, ms, fn),
      clearTimer: (name) => room.#clearTimer(name),
      deadline: (name) => room.#timers.get(name)?.at,
      send: (to, type, data) => {
        const seat = to === "host" ? host : room.#seats.get(to.id);
        seat?.client?.send("msg", { type, data });
      },
      broadcast: (type, data) => room.broadcast("msg", { type, data }),
      sync: () => room.#sync(),
      end: () => {
        room.#ended = true;
        host.client?.send("arcade:end");
      },
    };
    this.#game.state = this.#cfg.def.init({
      code: this.#cfg.code,
      maxPlayers: this.#cfg.maxPlayers,
    });

    this.onMessage("act", (client, message: { type?: unknown; data?: unknown }) => {
      const type = message?.type;
      if (typeof type !== "string") return;
      const who = client.userData as { pid: string; role: "host" | "player" } | undefined;
      if (!who) return;
      const def = this.#cfg.def;
      if (who.role === "host") {
        const handler = def.onHost && Object.hasOwn(def.onHost, type) ? def.onHost[type] : undefined;
        if (!handler || this.#host.client !== client) return;
        this.#run(`onHost.${type}`, () => handler(this.#game, message.data));
      } else {
        const handler =
          def.onPlayer && Object.hasOwn(def.onPlayer, type) ? def.onPlayer[type] : undefined;
        const seat = this.#seats.get(who.pid);
        if (!handler || !seat || seat.client !== client) return;
        this.#run(`onPlayer.${type}`, () => handler(this.#game, seat.player, message.data));
      }
      this.#sync();
    });
  }

  onAuth(_client: Client, options: { ticket?: unknown }): TicketClaims {
    const claims = verifyTicket(this.#cfg.secret, options?.ticket, {
      lid: this.#cfg.launchId,
      code: this.#cfg.code,
    });
    if (!claims) throw new ServerError(401, "invalid ticket");
    // Counted by player id, not by connection, so a returning player always
    // fits. (Colyseus's own maxClients would lock a full room against them.)
    if (
      claims.role === "player" &&
      !this.#seats.has(claims.pid) &&
      this.#seats.size >= this.#cfg.maxPlayers
    ) {
      throw new ServerError(403, "game is full");
    }
    return claims;
  }

  onJoin(client: Client, _options: unknown, claims: TicketClaims): void {
    client.userData = { pid: claims.pid, role: claims.role };

    if (claims.role === "host") {
      this.#attach(this.#host, client);
      if (this.#ended) client.send("arcade:end");
    } else {
      let seat = this.#seats.get(claims.pid);
      const isNew = !seat;
      if (!seat) {
        seat = { player: { id: claims.pid, name: claims.name, connected: false } };
        this.#seats.set(claims.pid, seat);
        this.#players.push(seat.player);
      }
      seat.player.name = claims.name;
      this.#attach(seat, client);
      if (isNew) {
        const joined = seat.player;
        this.#run("onJoin", () => this.#cfg.def.onJoin?.(this.#game, joined));
      }
    }
    this.#sync();
  }

  onLeave(client: Client): void {
    const who = client.userData as { pid: string; role: "host" | "player" } | undefined;
    if (!who) return;
    const seat = who.role === "host" ? this.#host : this.#seats.get(who.pid);
    // A replaced connection leaves after its successor arrived: not a departure.
    if (!seat || seat.client !== client) return;
    seat.client = undefined;
    seat.player.connected = false;
    seat.lastView = undefined;
    if (who.role === "player") {
      this.#run("onLeave", () => this.#cfg.def.onLeave?.(this.#game, seat.player));
    }
    this.#sync();
  }

  onDispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer.handle);
    this.#timers.clear();
  }

  #attach(seat: Seat, client: Client): void {
    const previous = seat.client;
    seat.client = client;
    seat.player.connected = true;
    seat.lastView = undefined;
    if (previous && previous !== client) previous.leave(CLOSE_REPLACED);
  }

  #setTimer(name: string, ms: number, fn: () => void): void {
    this.#clearTimer(name);
    const handle = setTimeout(() => {
      this.#timers.delete(name);
      this.#run(`timer.${name}`, fn);
      this.#sync();
    }, ms);
    this.#timers.set(name, { handle, at: Date.now() + ms });
  }

  #clearTimer(name: string): void {
    const timer = this.#timers.get(name);
    if (!timer) return;
    clearTimeout(timer.handle);
    this.#timers.delete(name);
  }

  /** A bug in one handler must not take the whole game down. */
  #run(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error(`[game] ${label} threw:`, error);
    }
  }

  #sync(): void {
    const def = this.#cfg.def;
    this.#push(this.#host, "hostView", () => def.hostView(this.#game));
    for (const seat of this.#seats.values()) {
      this.#push(seat, "playerView", () => def.playerView(this.#game, seat.player));
    }
  }

  #push(seat: Seat, label: string, compute: () => unknown): void {
    if (!seat.client) return;
    let json: string;
    try {
      json = JSON.stringify(compute() ?? null);
    } catch (error) {
      console.error(`[game] ${label} threw:`, error);
      return;
    }
    if (json === seat.lastView) return;
    seat.lastView = json;
    // `t` lets the browser correct its clock for countdowns against deadlines.
    seat.client.send("view", { t: Date.now(), v: JSON.parse(json) });
  }
}
