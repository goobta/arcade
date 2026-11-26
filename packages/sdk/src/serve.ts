// serve() is the whole process-level contract with the hub, implemented once:
// listen on $PORT, answer /healthz, serve the host and phone pages, and admit
// only connections carrying a ticket the hub signed for this launch.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRoom, defineServer, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { ArcadeRoom, configureRoom } from "./room.ts";
import type { GameDefinition } from "./types.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Games are started by the Arcade hub: run \`npm run dev\` ` +
        `in the arcade repo and launch the game from /host.`,
    );
  }
  return value;
}

/** Colyseus's browser client plus the Arcade helper, served as one script. */
function clientBundle(): string {
  const require = createRequire(import.meta.url);
  const colyseus = path.join(
    path.dirname(require.resolve("@colyseus/sdk/package.json")),
    "dist/colyseus.js",
  );
  const arcade = fileURLToPath(new URL("../client/arcade.js", import.meta.url));
  return `${readFileSync(colyseus, "utf8")}\n;${readFileSync(arcade, "utf8")}`;
}

export interface Served {
  /** Disconnects everyone and stops listening. The hub does this with SIGTERM. */
  shutdown(): Promise<void>;
}

export async function serve<S>(def: GameDefinition<S>): Promise<Served> {
  const port = Number(required("PORT"));
  const host = process.env.HOST ?? "127.0.0.1";
  const code = required("ARCADE_CODE");
  const publicDir = path.resolve(def.publicDir ?? "public");

  configureRoom({
    def,
    code,
    launchId: required("ARCADE_LAUNCH_ID"),
    secret: required("ARCADE_SECRET"),
    maxPlayers: Number(process.env.ARCADE_MAX_PLAYERS ?? 16),
  });

  // Failed joins would otherwise answer with HTTP 520-526, which Cloudflare
  // reserves for its own errors and replaces with a branded page.
  matchMaker.controller.standardHttpStatus = true;
  // The room is created below, by us. Browsers may only join it.
  matchMaker.controller.exposedMethods = ["joinById"];

  let ready = false;
  const bundle = clientBundle();

  const server = defineServer({
    greet: false,
    transport: new WebSocketTransport({
      // Well inside Cloudflare's ~100 s idle cutoff, and quick to notice a
      // phone that went to sleep.
      pingInterval: 8000,
      pingMaxRetries: 3,
      maxPayload: 16 * 1024,
    }),
    rooms: { game: defineRoom(ArcadeRoom) },
    express: (app) => {
      app.disable("x-powered-by");
      app.get("/healthz", (_req, res) => {
        res.status(ready ? 200 : 503).type("text/plain").send(ready ? "ok" : "starting");
      });
      app.get("/_sdk/arcade.js", (_req, res) => {
        res.type("text/javascript").set("Cache-Control", "no-cache").send(bundle);
      });
      const page = (file: string) => (_req: express.Request, res: express.Response) => {
        res.set("Cache-Control", "no-cache").sendFile(file, { root: publicDir });
      };
      app.get("/host", page("host.html"));
      app.get("/play", page("play.html"));
      app.use(
        express.static(publicDir, {
          index: false,
          dotfiles: "ignore",
          setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
        }),
      );
    },
  });

  await server.listen(port, host);
  await matchMaker.createRoom("game", {});
  ready = true;
  console.log(`game ready on ${host}:${port} (room ${code})`);

  // If the hub dies without stopping us, do not linger holding the port.
  const parent = Number(process.env.ARCADE_PARENT_PID);
  if (parent) {
    setInterval(() => {
      if (process.ppid !== parent) process.exit(0);
    }, 5000).unref();
  }

  return { shutdown: () => server.gracefullyShutdown(false) };
}
