import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createGameProxy, type GameProxy } from "../src/proxy.ts";
import { Runner, type Launch } from "../src/runner.ts";
import { fixture, freePort } from "./helpers.ts";

let runner: Runner;
let proxy: GameProxy;
let server: http.Server;
let base: string;
let launch: Launch;

before(async () => {
  runner = new Runner({ maxGames: 2, portBase: await freePort(), heapMb: 64, publicUrl: "http://x", log: () => {} });
  proxy = createGameProxy(runner);
  server = http.createServer((req, res) => proxy.web(req, res));
  server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `127.0.0.1:${(server.address() as { port: number }).port}`;
  launch = await runner.launch(fixture("ok"), { code: "BCDF", maxPlayers: 4 });
});

after(async () => {
  await runner.stopAll();
  proxy.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function socket(path: string): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}${path}`);
    ws.once("message", (data) => resolve({ ws, first: String(data) }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}

test("requests reach the game with the launch prefix stripped", async () => {
  const response = await fetch(`http://${base}/g/${launch.id}/echo?round=2`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "/echo?round=2");
});

test("the bare launch path maps to the game's root", async () => {
  const response = await fetch(`http://${base}/g/${launch.id}`);
  assert.equal(response.status, 404); // the fixture has no "/" page, but it was asked
  assert.equal(await response.text(), "not found");
});

test("websockets are proxied in both directions, prefix stripped", async () => {
  const { ws, first } = await socket(`/g/${launch.id}/room/BCDF?sessionId=abc`);
  assert.equal(first, "hello /room/BCDF?sessionId=abc");
  const reply = new Promise((resolve) => ws.once("message", (data) => resolve(String(data))));
  ws.send("ping");
  assert.equal(await reply, "echo ping");
  ws.close();
});

test("an unknown launch id is a 404, for pages and for websockets", async () => {
  const response = await fetch(`http://${base}/g/AAAAAAAAAAAAAAAA/play`);
  assert.equal(response.status, 404);
  await assert.rejects(socket("/g/AAAAAAAAAAAAAAAA/room"), /status 404/);
});

test("a stopped game's old URL stops working", async () => {
  const short = await runner.launch(fixture("ok"), { code: "BCDF", maxPlayers: 4 });
  assert.equal((await fetch(`http://${base}/g/${short.id}/healthz`)).status, 200);
  await runner.stop(short.id);
  assert.equal((await fetch(`http://${base}/g/${short.id}/healthz`)).status, 404);
});

test("only /g/ paths are claimed", () => {
  assert.equal(proxy.matches("/g/abc/play"), true);
  assert.equal(proxy.matches("/games"), false);
  assert.equal(proxy.matches("/lobby"), false);
  assert.equal(proxy.matches(undefined), false);
});
