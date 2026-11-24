// Forwards /g/<launchId>/... to the game process behind that launch, with the
// prefix stripped so a game sees plain /host, /play, /healthz.
//
// The launch id is random per spawn, so a tab left open from an earlier game
// gets a 404 rather than reaching whatever is running now.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createProxyServer } from "http-proxy-3";
import type { Runner } from "./runner.ts";

const PREFIX = /^\/g\/([A-Za-z0-9_-]{8,40})(\/[^?#]*)?(\?.*)?$/;

export interface GameProxy {
  /** True when the URL is under /g/ (whether or not the launch exists). */
  matches(url: string | undefined): boolean;
  web(req: IncomingMessage, res: ServerResponse): void;
  ws(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export function createGameProxy(runner: Runner): GameProxy {
  const proxy = createProxyServer({ ws: true });

  proxy.on("error", (_error, _req, res) => {
    // `res` is the client socket for a failed websocket upgrade.
    if (res && "writeHead" in res) {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("The game is not responding.");
    } else {
      res?.destroy();
    }
  });

  /** Rewrites req.url in place and returns the target, or null for an unknown launch. */
  function route(req: IncomingMessage): string | null {
    const match = PREFIX.exec(req.url ?? "");
    if (!match) return null;
    const launch = runner.get(match[1]);
    if (!launch || launch.status !== "running") return null;
    req.url = (match[2] || "/") + (match[3] ?? "");
    return `http://127.0.0.1:${launch.port}`;
  }

  return {
    matches: (url) => typeof url === "string" && url.startsWith("/g/"),
    web(req, res) {
      const target = route(req);
      if (!target) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("This game is no longer running.");
        return;
      }
      proxy.web(req, res, { target });
    },
    ws(req, socket, head) {
      const target = route(req);
      if (!target) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      proxy.ws(req, socket, head, { target });
    },
    close: () => proxy.close(),
  };
}
