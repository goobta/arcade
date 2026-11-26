// The SDK end to end: a real game served in this process, joined with the
// real Colyseus client, exactly as a browser would.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, type Room } from "@colyseus/sdk";
import { serve, type Game, type Served } from "../src/index.ts";
import { signTicket, type Role } from "../src/ticket.ts";

const SECRET = "launch-secret";
const LAUNCH = "launch-1";
const CODE = "BCDF";

interface State {
  count: number;
  secrets: Record<string, string>;
  joined: string[];
  left: string[];
  fired: string[];
}

let served: Served;
let base: string;
let game: Game<State>;

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const found = (probe.address() as { port: number }).port;
      probe.close(() => resolve(found));
    });
  });
  base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    HOST: "127.0.0.1",
    ARCADE_CODE: CODE,
    ARCADE_LAUNCH_ID: LAUNCH,
    ARCADE_SECRET: SECRET,
    ARCADE_MAX_PLAYERS: "3",
  });
  served = await serve<State>({
    publicDir: fileURLToPath(new URL("./fixtures/public", import.meta.url)),
    init: () => ({ count: 0, secrets: {}, joined: [], left: [], fired: [] }),
    onHost: {
      bump(g) {
        game = g;
        g.state.count += 1;
      },
      explode() {
        throw new Error("handler bug");
      },
      arm(g, ms: number) {
        g.timer("bomb", ms, () => g.state.fired.push("bomb"));
      },
      disarm(g) {
        g.clearTimer("bomb");
      },
      whisper(g, to: string) {
        const player = g.players.find((p) => p.name === to);
        if (player) g.send(player, "psst", { from: "host" });
      },
      shout(g) {
        g.broadcast("announce", "hello all");
      },
      finish(g) {
        g.end();
      },
    },
    onPlayer: {
      secret(g, player, word: string) {
        g.state.secrets[player.id] = word;
      },
    },
    onJoin: (g, player) => void g.state.joined.push(player.name),
    onLeave: (g, player) => void g.state.left.push(player.name),
    hostView: (g) => ({
      count: g.state.count,
      players: g.players.map((p) => ({ name: p.name, connected: p.connected })),
      // Games will put player objects straight into views; that must be safe.
      raw: g.players,
      // Deliberately only how many, never what.
      secretsIn: Object.keys(g.state.secrets).length,
      joined: g.state.joined,
      left: g.state.left,
      fired: g.state.fired,
      deadline: g.deadline("bomb") ?? null,
    }),
    playerView: (g, p) => ({ count: g.state.count, mine: g.state.secrets[p.id] ?? null }),
  });
});

after(async () => {
  await served.shutdown();
});

function ticket(pid: string, role: Role = "player", extra: object = {}): string {
  return signTicket(SECRET, {
    v: 1, lid: LAUNCH, code: CODE, gid: "test", pid, name: pid.toUpperCase(), role, exp: Date.now() + 60_000, ...extra,
  });
}

interface Seat {
  room: Room;
  views: any[];
  messages: any[];
  left: number | null;
  view: () => any;
}

async function join(pid: string, role: Role = "player", extra: object = {}): Promise<Seat> {
  const room = await new Client(base).joinById(CODE, { ticket: ticket(pid, role, extra) });
  room.reconnection.enabled = false;
  const seat: Seat = { room, views: [], messages: [], left: null, view: () => seat.views.at(-1) };
  room.onMessage("view", (message: { v: unknown }) => seat.views.push(message.v));
  room.onMessage("msg", (message: unknown) => seat.messages.push(message));
  room.onMessage("arcade:end", () => seat.messages.push("arcade:end"));
  room.onLeave((code: number) => (seat.left = code));
  await until(() => seat.views.length > 0);
  return seat;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const act = (seat: Seat, type: string, data?: unknown) => seat.room.send("act", { type, data });
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

let host: Seat;
let ann: Seat;
let bob: Seat;

test("the process contract: health, pages, client bundle", async () => {
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
  assert.match(await (await fetch(`${base}/host`)).text(), /host page/);
  assert.match(await (await fetch(`${base}/play`)).text(), /play page/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  const bundle = await (await fetch(`${base}/_sdk/arcade.js`)).text();
  assert.match(bundle, /Colyseus/);
  assert.match(bundle, /window\.Arcade/);
  for (const path of ["/%2e%2e/outside.txt", "/..%2foutside.txt", "/.env", "/missing.html"]) {
    assert.notEqual((await fetch(base + path)).status, 200, path);
  }
});

test("nobody gets in without a ticket the hub signed for this launch", async () => {
  const client = new Client(base);
  await assert.rejects(client.joinById(CODE, {}));
  await assert.rejects(client.joinById(CODE, { ticket: "forged.ticket" }));
  await assert.rejects(client.joinById(CODE, { ticket: signTicket("wrong-secret", {
    v: 1, lid: LAUNCH, code: CODE, gid: "test", pid: "eve", name: "Eve", role: "host", exp: Date.now() + 60_000,
  }) }));
  await assert.rejects(client.joinById(CODE, { ticket: ticket("eve", "player", { exp: Date.now() - 1 }) }));
  await assert.rejects(client.joinById(CODE, { ticket: ticket("eve", "player", { lid: "another-launch" }) }));
});

test("browsers can only join the one room, never create or list rooms", async () => {
  const client = new Client(base);
  const options = { ticket: ticket("eve") };
  await assert.rejects(client.create("game", options));
  await assert.rejects(client.joinOrCreate("game", options));
  await assert.rejects(client.join("game", options));
  await assert.rejects(client.joinById("ZZZZ", options));
});

test("failed joins answer with ordinary HTTP statuses, not Cloudflare's 52x range", async () => {
  const response = await fetch(`${base}/matchmake/create/game`, { method: "POST", body: "{}" });
  assert.ok(response.status >= 400 && response.status < 520, `status ${response.status}`);
  const missing = await fetch(`${base}/matchmake/joinById/ZZZZ`, { method: "POST", body: "{}" });
  assert.ok(missing.status >= 400 && missing.status < 520, `status ${missing.status}`);
});

test("host and players each get their own view", async () => {
  host = await join("host", "host");
  assert.deepEqual(host.view().players, []);
  ann = await join("ann");
  bob = await join("bob");
  await until(() => host.view().players.length === 2);
  assert.deepEqual(host.view().players, [
    { name: "ANN", connected: true },
    { name: "BOB", connected: true },
  ]);
  assert.deepEqual(host.view().joined, ["ANN", "BOB"]);
  assert.deepEqual(ann.view(), { count: 0, mine: null });
  assert.deepEqual(host.view().raw, [
    { id: "ann", name: "ANN", connected: true },
    { id: "bob", name: "BOB", connected: true },
  ], "a player object is plain data: id, name, connected");
});

test("a handler's changes reach everyone, and private state reaches only its owner", async () => {
  act(host, "bump");
  await until(() => ann.view().count === 1 && bob.view().count === 1 && host.view().count === 1);

  act(ann, "secret", "platypus");
  await until(() => ann.view().mine === "platypus");
  await until(() => host.view().secretsIn === 1);
  assert.equal(bob.view().mine, null);
  for (const seat of [host, bob]) {
    assert.equal(JSON.stringify(seat.views).includes("platypus"), false, "the secret leaked");
  }
});

test("an unchanged view is not re-sent", async () => {
  const before = bob.views.length;
  act(ann, "secret", "platypus"); // same value: bob's view does not change
  act(ann, "secret", "wombat"); // changes ann's view only
  await until(() => ann.view().mine === "wombat");
  await settle();
  assert.equal(bob.views.length, before);
});

test("players cannot call host actions, and unknown actions are ignored", async () => {
  const before = host.view().count;
  act(ann, "bump");
  act(ann, "finish");
  act(ann, "constructor");
  act(ann, "toString");
  act(host, "secret", "host is not a player");
  act(host, "__proto__");
  ann.room.send("act", "not an object");
  ann.room.send("act", { type: 42 });
  await settle();
  assert.equal(host.view().count, before);
  assert.equal(host.view().secretsIn, 1);
  assert.equal(host.messages.includes("arcade:end"), false);
});

test("a handler that throws does not take the game down", async () => {
  act(host, "explode");
  act(host, "bump");
  await until(() => host.view().count === 2);
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
});

test("timers fire once, expose a deadline, and can be cancelled", async () => {
  act(host, "arm", 150);
  await until(() => host.view().deadline !== null);
  const deadline = host.view().deadline;
  assert.ok(Math.abs(deadline - (Date.now() + 150)) < 150, "deadline is about 150 ms away");
  await until(() => host.view().fired.length === 1);
  assert.equal(host.view().deadline, null);

  act(host, "arm", 150);
  await until(() => host.view().deadline !== null);
  act(host, "disarm");
  await until(() => host.view().deadline === null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(host.view().fired, ["bomb"], "a cleared timer never fires");
});

test("direct and broadcast messages", async () => {
  act(host, "whisper", "ANN");
  await until(() => ann.messages.length === 1);
  assert.deepEqual(ann.messages[0], { type: "psst", data: { from: "host" } });
  assert.deepEqual(bob.messages, []);

  act(host, "shout");
  await until(() => bob.messages.length === 1 && ann.messages.length === 2 && host.messages.length === 1);
  assert.deepEqual(bob.messages[0], { type: "announce", data: "hello all" });
});

test("a dropped player shows as away and keeps their seat", async () => {
  await bob.room.leave(false);
  await until(() => host.view().players[1].connected === false);
  assert.deepEqual(host.view().left, ["BOB"]);
  assert.equal(host.view().players.length, 2);
});

test("coming back takes the same seat, with state intact and no second onJoin", async () => {
  bob = await join("bob");
  await until(() => host.view().players[1].connected === true);
  assert.equal(host.view().players.length, 2);
  assert.deepEqual(host.view().joined, ["ANN", "BOB"]);
  assert.equal(bob.view().count, 2, "the returning player gets the current view immediately");
});

test("opening the same seat twice replaces the older connection", async () => {
  const second = await join("ann");
  await until(() => ann.left !== null);
  assert.equal(ann.left, 4901);
  assert.equal(second.view().mine, "wombat", "the new connection sees the same private state");
  await settle();
  assert.equal(host.view().players[0].connected, true, "being replaced is not a departure");
  assert.deepEqual(host.view().left, ["BOB"]);
  ann = second;
});

test("the player limit counts people, not connections", async () => {
  const cat = await join("cat");
  await until(() => host.view().players.length === 3);
  await assert.rejects(new Client(base).joinById(CODE, { ticket: ticket("dan") }), /full/);
  // Someone already seated can always get back in, even at the limit.
  const again = await join("cat");
  await until(() => cat.left === 4901);
  assert.equal(host.view().players.length, 3);
  await again.room.leave(false);
});

test("end() tells the host screen to close the game, now and on reconnect", async () => {
  act(host, "finish");
  await until(() => host.messages.includes("arcade:end"));
  assert.equal(ann.messages.includes("arcade:end"), false);
  const hostAgain = await join("host", "host");
  await until(() => hostAgain.messages.includes("arcade:end"));
});

test("the game handle works outside handlers too", async () => {
  game.state.count = 99;
  game.sync();
  await until(() => ann.view().count === 99);
  assert.equal(game.code, CODE);
  assert.equal(game.hostConnected, true);
});
