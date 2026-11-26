// Wires the pieces into one HTTP server: pages, the small JSON API, the lobby
// websocket and the game proxy.
import { readFileSync, readdirSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-generator";
import { Auth, RateLimiter } from "./auth.ts";
import { scanGames, type GameManifest } from "./catalog.ts";
import type { Config } from "./config.ts";
import { Lobby } from "./lobby.ts";
import { createGameProxy } from "./proxy.ts";
import { Runner } from "./runner.ts";
import { CODE_PATTERN, Sessions } from "./sessions.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const PAGE_HEADERS = {
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Games are framed by the hub's own pages and by nothing else.
  "Content-Security-Policy": "frame-ancestors 'self'",
};

export interface Hub {
  server: http.Server;
  runner: Runner;
  sessions: Sessions;
  /** Stops every game and closes the server. */
  close(): Promise<void>;
}

export function createHub(config: Config, log: (line: string) => void = console.log): Hub {
  const auth = new Auth(config.hostPin, { secureCookies: config.publicUrl.protocol === "https:" });
  const pinPerIp = new RateLimiter(5, 15 * 60_000);
  const pinGlobal = new RateLimiter(50, 15 * 60_000);
  const joinLimiter = new RateLimiter(30, 60_000);

  const games = (): GameManifest[] => scanGames(config.gamesDir).games;
  const startup = scanGames(config.gamesDir);
  log(`games: ${startup.games.map((game) => game.id).join(", ") || "(none)"}`);
  for (const problem of startup.problems) log(`skipped game ${problem}`);

  const runner = new Runner({
    maxGames: config.maxGames,
    portBase: config.portBase,
    heapMb: config.gameHeapMb,
    publicUrl: config.publicUrl.origin,
    log,
  });
  const sessions = new Sessions({
    runner,
    games,
    maxPlayers: config.maxPlayers,
    maxSessions: config.maxSessions,
    idleMs: config.idleMs,
    maxGameMs: config.maxGameMs,
    log,
  });
  const proxy = createGameProxy(runner);

  // Caddy sets X-Real-IP to the real client; nothing else can reach the hub.
  const clientIp = (req: IncomingMessage): string => {
    const header = req.headers["x-real-ip"];
    return (Array.isArray(header) ? header[0] : header) || req.socket.remoteAddress || "unknown";
  };
  const joinUrl = (code: string): string => `${config.publicUrl.origin}/${code}`;
  const lobby = new Lobby({ sessions, auth, joinLimiter, joinUrl, clientIp });

  // Hub pages are a fixed, small set read once; nothing is served by path lookup.
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const name of readdirSync(PUBLIC_DIR)) {
    const type = TYPES[path.extname(name)];
    if (type) assets.set(name, { body: readFileSync(path.join(PUBLIC_DIR, name)), type });
  }

  function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra = {}): void {
    res.writeHead(status, { "Content-Type": type, ...PAGE_HEADERS, ...extra });
    res.end(body);
  }
  const json = (res: ServerResponse, status: number, body: unknown, extra = {}): void =>
    send(res, status, "application/json", JSON.stringify(body), extra);
  const asset = (res: ServerResponse, name: string): void => {
    const file = assets.get(name);
    if (!file) return send(res, 404, "text/plain", "Not found");
    send(res, 200, file.type, file.body);
  };

  /** Browsers always send Origin on POSTs and websocket upgrades; it must be ours. */
  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser: no ambient cookies to abuse
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2048) throw new Error("too large");
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (proxy.matches(req.url)) return proxy.web(req, res);

    const url = new URL(req.url ?? "/", "http://hub");
    const route = url.pathname;
    const isHost = () => auth.isHost(req.headers.cookie);

    if (req.method === "GET" || req.method === "HEAD") {
      if (route === "/healthz") return send(res, 200, "text/plain", "ok");
      if (route === "/") return asset(res, "index.html");
      if (route === "/host") return asset(res, "host.html");
      if (route.startsWith("/assets/")) return asset(res, route.slice("/assets/".length));
      if (route === "/favicon.ico") return asset(res, "favicon.svg");
      // arcade.goobta.io/BCDF: the join link and what the QR code encodes.
      if (CODE_PATTERN.test(route.slice(1).toUpperCase())) return asset(res, "index.html");

      if (route === "/api/host/me") return json(res, 200, { host: isHost() });

      if (route === "/api/qr.svg") {
        const code = (url.searchParams.get("code") ?? "").toUpperCase();
        if (!CODE_PATTERN.test(code)) return send(res, 400, "text/plain", "Bad code");
        const qr = qrcode(0, "M");
        qr.addData(joinUrl(code));
        qr.make();
        return send(res, 200, "image/svg+xml", qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true }));
      }

      if (route === "/api/games") {
        if (!isHost()) return json(res, 401, { error: "not_host" });
        return json(res, 200, {
          games: games().map((game) => ({
            id: game.id,
            name: game.name,
            blurb: game.blurb,
            minPlayers: game.minPlayers,
            maxPlayers: game.maxPlayers,
            thumbnail: game.thumbnail ? `/api/games/${game.id}/thumb` : null,
          })),
        });
      }

      const thumb = /^\/api\/games\/([a-z0-9-]+)\/thumb$/.exec(route);
      if (thumb) {
        const file = games().find((game) => game.id === thumb[1])?.thumbnail;
        const type = file && TYPES[path.extname(file).toLowerCase()];
        if (!file || !type) return send(res, 404, "text/plain", "Not found");
        return send(res, 200, type, readFileSync(file), { "Cache-Control": "max-age=300" });
      }

      if (route === "/api/status") {
        if (!isHost()) return json(res, 401, { error: "not_host" });
        return json(res, 200, {
          sessions: sessions.list().map((session) => ({
            code: session.code,
            players: session.members.size,
            game: session.game?.manifest.id ?? null,
          })),
          processes: runner.list().map((launch) => ({
            gameId: launch.gameId,
            status: launch.status,
            pid: launch.pid,
            uptimeMs: Date.now() - launch.startedAt,
          })),
        });
      }
    }

    if (req.method === "POST") {
      if (!sameOrigin(req)) return json(res, 403, { error: "bad_origin" });

      if (route === "/api/host/login") {
        // Wrong PINs are counted per address and overall, so the PIN cannot be
        // brute-forced from one place or from many. Once locked out, even the
        // right PIN is refused until the window passes.
        const ip = clientIp(req);
        if (!pinPerIp.allowed(ip) || !pinGlobal.allowed("all")) {
          return json(res, 429, { error: "rate_limited" });
        }
        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch {
          return json(res, 400, { error: "bad_request" });
        }
        if (!auth.checkPin(body.pin)) {
          pinPerIp.take(ip);
          pinGlobal.take("all");
          return json(res, 401, { error: "wrong_pin" });
        }
        return json(res, 200, { host: true }, { "Set-Cookie": auth.hostCookie() });
      }

      if (route === "/api/host/logout") {
        return json(res, 200, { host: false }, { "Set-Cookie": auth.clearHostCookie() });
      }
    }

    send(res, 404, "text/plain", "Not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`request failed: ${(error as Error).stack ?? error}`);
      if (!res.headersSent) send(res, 500, "text/plain", "Internal error");
      else res.destroy();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (!sameOrigin(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    } else if (proxy.matches(req.url)) {
      proxy.ws(req, socket, head);
    } else if (req.url === "/lobby") {
      lobby.handleUpgrade(req, socket, head);
    } else {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
  });

  const sweeper = setInterval(() => {
    sessions.sweep().catch((error) => log(`sweep failed: ${(error as Error).stack ?? error}`));
  }, config.sweepMs);
  sweeper.unref();

  return {
    server,
    runner,
    sessions,
    async close() {
      clearInterval(sweeper);
      await sessions.endAll("shutdown");
      await runner.stopAll();
      lobby.close();
      proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
