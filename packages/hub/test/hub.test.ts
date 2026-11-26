// The hub over real HTTP and websockets, with fixture games as processes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { alive, FIXTURE_GAMES, freePort, until } from "./helpers.ts";

const PIN = "test-host-pin";
let hub: Hub;
let origin: string;
let hostCookie: string;

before(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  hub = createHub(
    loadConfig({
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: "https://arcade.example",
      ARCADE_HOST_PIN: PIN,
      ARCADE_GAMES_DIR: FIXTURE_GAMES,
      ARCADE_PORT_BASE: String(await freePort()),
      ARCADE_MAX_PLAYERS: "3",
    }),
    () => {},
  );
  await new Promise<void>((resolve) => hub.server.listen(port, "127.0.0.1", resolve));
  hostCookie = await login("203.0.113.1");
});

after(async () => {
  await hub.close();
});

async function login(ip: string, pin = PIN): Promise<string> {
  const response = await fetch(`${origin}/api/host/login`, {
    method: "POST",
    headers: { "X-Real-IP": ip },
    body: JSON.stringify({ pin }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

/** A lobby client that records what it is sent. */
class Peer {
  ws: WebSocket;
  messages: any[] = [];
  closed = false;
  constructor(headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`${origin.replace("http", "ws")}/lobby`, { headers });
    this.ws.on("message", (data) => this.messages.push(JSON.parse(String(data))));
    this.ws.on("close", () => (this.closed = true));
    this.ws.on("error", () => (this.closed = true));
  }
  async send(message: object): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) await new Promise((resolve) => this.ws.once("open", resolve));
    this.ws.send(JSON.stringify(message));
  }
  async next(type: string, where: (m: any) => boolean = () => true): Promise<any> {
    let found: any;
    await until(() => (found = this.messages.find((m) => m.type === type && where(m))) !== undefined);
    return found;
  }
  get state(): any {
    return this.messages.findLast((m) => m.type === "state");
  }
}

async function openHost(code?: string): Promise<{ peer: Peer; code: string }> {
  const peer = new Peer({ Cookie: hostCookie });
  await peer.send({ type: "hello", role: "host", code });
  const welcome = await peer.next("welcome");
  return { peer, code: welcome.code };
}

async function joinPlayer(code: string, name: string, device?: string, ip = "198.51.100.7") {
  const peer = new Peer({ "X-Real-IP": ip });
  await peer.send({ type: "hello", role: "player", code, name, device });
  const welcome = await peer.next("welcome");
  await peer.next("state");
  return { peer, device: welcome.device as string };
}

test("pages and health", async () => {
  assert.equal(await (await fetch(`${origin}/healthz`)).text(), "ok");
  for (const path of ["/", "/host", "/BCDF", "/bcdf"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'self'/);
  }
  assert.match(await (await fetch(`${origin}/assets/shell.js`)).text(), /WebSocket/);
  for (const path of ["/nope", "/assets/../src/main.ts", "/assets/%2e%2e/package.json", "/AEIO", "/TOOLONG"]) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
});

test("the QR code encodes the public join link", async () => {
  const response = await fetch(`${origin}/api/qr.svg?code=bcdf`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^<svg /);
  assert.equal((await fetch(`${origin}/api/qr.svg?code=<script>`)).status, 400);
});

test("host-only endpoints need the host cookie", async () => {
  for (const path of ["/api/games", "/api/status"]) {
    assert.equal((await fetch(origin + path)).status, 401, path);
    assert.equal((await fetch(origin + path, { headers: { Cookie: "arcade_host=1.forged" } })).status, 401);
    assert.equal((await fetch(origin + path, { headers: { Cookie: hostCookie } })).status, 200);
  }
  assert.deepEqual(await (await fetch(`${origin}/api/host/me`)).json(), { host: false });
  assert.deepEqual(
    await (await fetch(`${origin}/api/host/me`, { headers: { Cookie: hostCookie } })).json(),
    { host: true },
  );
});

test("the catalog lists the games folder without exposing server paths", async () => {
  const body = await (await fetch(`${origin}/api/games`, { headers: { Cookie: hostCookie } })).json();
  assert.deepEqual(body.games.map((g: any) => g.id).sort(), [
    "crasher", "exits-early", "never-healthy", "ok", "slow", "stubborn",
  ]);
  assert.deepEqual(Object.keys(body.games[0]).sort(), [
    "blurb", "id", "maxPlayers", "minPlayers", "name", "thumbnail",
  ]);
});

test("five wrong PINs lock an address out, even with the right PIN", async () => {
  const attempt = (pin: string) =>
    fetch(`${origin}/api/host/login`, {
      method: "POST",
      headers: { "X-Real-IP": "192.0.2.50" },
      body: JSON.stringify({ pin }),
    });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await attempt("wrong-pin")).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401]);
  // Locked out now, even with the right PIN.
  assert.equal((await attempt(PIN)).status, 429);
  // Another address is unaffected.
  await login("192.0.2.51");
});

test("signing in correctly, however often, never locks the host out", async () => {
  for (let i = 0; i < 12; i++) await login("192.0.2.80");
});

test("a party behind one address can all join and reconnect freely", async (t) => {
  const host = await openHost();
  t.after(() => hub.sessions.end(hub.sessions.get(host.code)!, "test"));
  const first = await joinPlayer(host.code, "Ada", undefined, "198.51.100.99");
  for (let i = 0; i < 40; i++) {
    const again = await joinPlayer(host.code, "Ada", first.device, "198.51.100.99");
    again.peer.ws.close();
  }
});

test("a login posted from another site is refused", async () => {
  const response = await fetch(`${origin}/api/host/login`, {
    method: "POST",
    headers: { Origin: "https://evil.example", "X-Real-IP": "192.0.2.60" },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("malformed login bodies are rejected", async () => {
  const post = (body: string) =>
    fetch(`${origin}/api/host/login`, { method: "POST", headers: { "X-Real-IP": "192.0.2.70" }, body });
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post("x".repeat(5000))).status, 400);
  assert.equal((await post('{"pin":{"$ne":""}}')).status, 401);
});

test("a websocket from another site is refused", async () => {
  const peer = new Peer({ Origin: "https://evil.example", Cookie: hostCookie });
  await until(() => peer.closed);
  assert.deepEqual(peer.messages, []);
});

test("claiming to be the host without the cookie is refused", async () => {
  const peer = new Peer();
  await peer.send({ type: "hello", role: "host" });
  assert.equal((await peer.next("error")).code, "not_host");
  await until(() => peer.closed);
  assert.equal(hub.sessions.list().length, 0, "no party was created");
});

test("a wrong room code is refused", async () => {
  const peer = new Peer({ "X-Real-IP": "198.51.100.20" });
  await peer.send({ type: "hello", role: "player", code: "ZZZZ", name: "Nobody" });
  assert.equal((await peer.next("error")).code, "bad_code");
  await until(() => peer.closed);
});

test("room codes cannot be guessed by brute force", async () => {
  const codes = [];
  for (let i = 0; i < 32; i++) {
    const peer = new Peer({ "X-Real-IP": "198.51.100.30" });
    await peer.send({ type: "hello", role: "player", code: "ZZZZ", name: "Guesser" });
    codes.push((await peer.next("error")).code);
  }
  assert.deepEqual([...new Set(codes.slice(0, 30))], ["bad_code"]);
  assert.deepEqual(codes.slice(30), ["rate_limited", "rate_limited"]);
});

test("a party from join to game and back", async (t) => {
  const host = await openHost();
  t.after(() => hub.sessions.end(hub.sessions.get(host.code)!, "test"));
  const welcome = await host.peer.next("welcome");
  assert.equal(welcome.joinUrl, `https://arcade.example/${host.code}`);

  const ada = await joinPlayer(host.code.toLowerCase(), "Ada");
  const grace = await joinPlayer(host.code, "Grace");
  await host.peer.next("state", (s) => s.players.length === 2);
  assert.equal(ada.peer.state.you.name, "Ada");
  assert.notEqual(ada.peer.state.you.id, grace.peer.state.you.id);

  // A player cannot launch, close or end anything.
  await ada.peer.send({ type: "launch", gameId: "ok" });
  await ada.peer.send({ type: "end" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(hub.runner.list().length, 0);
  assert.ok(hub.sessions.get(host.code));

  // The same phone coming back keeps its id; a forged token gets a new one.
  const again = await joinPlayer(host.code, "Ada", ada.device);
  assert.equal(again.peer.state.you.id, ada.peer.state.you.id);
  assert.equal(again.peer.state.players.length, 2);

  await host.peer.send({ type: "launch", gameId: "ok" });
  const running = await host.peer.next("state", (s) => s.game?.status === "running");
  const adaState = await ada.peer.next("state", (s) => s.game?.status === "running");
  assert.match(running.game.url, /^\/g\/[\w-]+\/host#t=/);
  assert.match(adaState.game.url, /^\/g\/[\w-]+\/play#t=/);
  assert.notEqual(running.game.url.split("#t=")[1], adaState.game.url.split("#t=")[1]);

  // The game's pages are reachable through the hub at that URL.
  const page = await fetch(origin + adaState.game.url.split("#")[0]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/play/);

  const [launch] = hub.runner.list();
  assert.ok(alive(launch.pid));
  const status = await (await fetch(`${origin}/api/status`, { headers: { Cookie: hostCookie } })).json();
  assert.equal(status.processes.length, 1);
  assert.deepEqual(status.sessions, [{ code: host.code, players: 2, game: "ok" }]);

  await host.peer.send({ type: "close" });
  await host.peer.next("state", (s) => s.game === null && s !== running && host.peer.messages.indexOf(s) > host.peer.messages.indexOf(running));
  await until(() => !alive(launch.pid));
  assert.equal(hub.runner.list().length, 0);
  assert.equal((await fetch(origin + adaState.game.url.split("#")[0])).status, 404, "old game URL is dead");
});

test("a full party refuses new players and keeps the ones it has", async (t) => {
  const host = await openHost();
  t.after(() => hub.sessions.end(hub.sessions.get(host.code)!, "test"));
  for (const name of ["A", "B", "C"]) await joinPlayer(host.code, name);
  const extra = new Peer({ "X-Real-IP": "198.51.100.8" });
  await extra.send({ type: "hello", role: "player", code: host.code, name: "D" });
  assert.equal((await extra.next("error")).code, "full");
  assert.equal(host.peer.state.players.length, 3);
});

test("a game that fails to start, or crashes, puts the host back at the picker", async (t) => {
  const host = await openHost();
  t.after(() => hub.sessions.end(hub.sessions.get(host.code)!, "test"));

  await host.peer.send({ type: "launch", gameId: "exits-early" });
  assert.equal((await host.peer.next("error")).code, "game_failed");
  assert.equal(host.peer.state.game, null);

  await host.peer.send({ type: "launch", gameId: "no-such-game" });
  assert.equal((await host.peer.next("error", (e) => e.code === "unknown_game")).code, "unknown_game");

  await host.peer.send({ type: "launch", gameId: "crasher" });
  await host.peer.next("state", (s) => s.game?.status === "running");
  assert.equal((await host.peer.next("error", (e) => e.code === "game_crashed")).code, "game_crashed");
  assert.equal(host.peer.state.game, null);
  assert.equal(hub.runner.list().length, 0);
});

test("only one game runs at a time by default", async (t) => {
  const first = await openHost();
  const second = await openHost();
  t.after(() => hub.sessions.end(hub.sessions.get(first.code)!, "test"));
  t.after(() => hub.sessions.end(hub.sessions.get(second.code)!, "test"));
  assert.notEqual(first.code, second.code);

  await first.peer.send({ type: "launch", gameId: "ok" });
  await first.peer.next("state", (s) => s.game?.status === "running");
  await second.peer.send({ type: "launch", gameId: "ok" });
  assert.equal((await second.peer.next("error")).code, "busy");
  assert.equal(hub.runner.list().length, 1);
});

test("a host refresh reattaches to the same party", async (t) => {
  const host = await openHost();
  t.after(() => hub.sessions.end(hub.sessions.get(host.code)!, "test"));
  await joinPlayer(host.code, "Ada");
  host.peer.ws.close();
  const back = await openHost(host.code);
  assert.equal(back.code, host.code);
  assert.equal((await back.peer.next("state")).players.length, 1);
});

test("ending the party disconnects players and frees the code", async () => {
  const host = await openHost();
  const ada = await joinPlayer(host.code, "Ada");
  await host.peer.send({ type: "end" });
  assert.deepEqual(await ada.peer.next("bye"), { type: "bye", reason: "host" });
  await until(() => ada.peer.closed && host.peer.closed);
  assert.equal(hub.sessions.get(host.code), undefined);
});

test("garbage on the lobby socket closes it without harming the hub", async () => {
  for (const payload of ["not json", "null", JSON.stringify({ type: "launch", gameId: "ok" }), "x".repeat(5000)]) {
    const peer = new Peer();
    await new Promise((resolve) => peer.ws.once("open", resolve));
    peer.ws.send(payload);
    await until(() => peer.closed);
  }
  assert.equal(await (await fetch(`${origin}/healthz`)).text(), "ok");
});
