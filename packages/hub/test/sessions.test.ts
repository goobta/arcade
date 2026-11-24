import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { verifyTicket } from "@arcade/sdk/ticket";
import type { GameManifest } from "../src/catalog.ts";
import { CapacityError, type Launch, type Runner } from "../src/runner.ts";
import { cleanName, LobbyError, Sessions, type Conn } from "../src/sessions.ts";

const MINUTE = 60_000;

function game(id: string): GameManifest {
  return {
    id, name: `Game ${id}`, blurb: "", minPlayers: 1, maxPlayers: 8, start: ["node", "x"],
    hostPath: "host", playPath: "play", healthPath: "healthz", startTimeoutMs: 1000, dir: "/tmp",
  };
}

/** Stands in for real processes: launches are instant unless a test holds them. */
class FakeRunner extends EventEmitter {
  launches: Launch[] = [];
  stopped: string[] = [];
  capacity = 1;
  failNext: Error | null = null;
  hold: Promise<void> | null = null;
  #n = 0;

  async launch(manifest: GameManifest): Promise<Launch> {
    if (this.hold) await this.hold;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.running().length >= this.capacity) throw new CapacityError();
    const n = ++this.#n;
    const launch: Launch = {
      id: `launch-${n}`.padEnd(12, "x"), gameId: manifest.id, port: 4000 + n,
      secret: `secret-${n}`, startedAt: 0, pid: 1000 + n, status: "running",
    };
    this.launches.push(launch);
    return launch;
  }
  async stop(id: string): Promise<void> {
    const launch = this.launches.find((l) => l.id === id);
    if (launch && launch.status === "running") {
      launch.status = "exited";
      this.stopped.push(id);
    }
  }
  running(): Launch[] {
    return this.launches.filter((l) => l.status === "running");
  }
  crash(launch: Launch): void {
    launch.status = "exited";
    this.emit("exit", launch, { expected: false });
  }
}

class FakeConn implements Conn {
  sent: any[] = [];
  closed = false;
  send(message: object): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  get state(): any {
    return this.sent.findLast((m) => m.type === "state");
  }
  of(type: string): any[] {
    return this.sent.filter((m) => m.type === type);
  }
}

function setup(options: { maxPlayers?: number; maxSessions?: number; idleMinutes?: number; maxGameMinutes?: number } = {}) {
  const runner = new FakeRunner();
  const clock = { now: 0 };
  const sessions = new Sessions({
    runner: runner as unknown as Runner,
    games: () => [game("trivia"), game("draw")],
    maxPlayers: options.maxPlayers ?? 4,
    maxSessions: options.maxSessions ?? 2,
    idleMs: (options.idleMinutes ?? 15) * MINUTE,
    maxGameMs: (options.maxGameMinutes ?? 240) * MINUTE,
    now: () => clock.now,
    log: () => {},
  });
  const session = sessions.create();
  const host = new FakeConn();
  sessions.attachHost(session, host);
  const join = (id: string, name: string) => {
    const conn = new FakeConn();
    const member = sessions.joinPlayer(session, id, name, conn);
    return { conn, member };
  };
  return { runner, clock, sessions, session, host, join };
}

test("room codes are four consonants and unique", () => {
  const { sessions } = setup({ maxSessions: 60 });
  const codes = new Set([...Array(50)].map(() => sessions.create().code));
  assert.equal(codes.size, 50);
  for (const code of codes) assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
});

test("codes are found case-insensitively; junk finds nothing", () => {
  const { sessions, session } = setup();
  assert.equal(sessions.get(session.code.toLowerCase()), session);
  assert.equal(sessions.get("AEIO"), undefined);
  assert.equal(sessions.get(undefined), undefined);
  assert.equal(sessions.get(42), undefined);
});

test("the number of open parties is capped", () => {
  const { sessions } = setup({ maxSessions: 2 });
  sessions.create();
  assert.throws(() => sessions.create(), (error: LobbyError) => error.code === "too_many_sessions");
});

test("names are cleaned for the projector", () => {
  assert.equal(cleanName("  Ada   Lovelace  "), "Ada Lovelace");
  assert.equal(cleanName("a\u0000b​c\nd"), "abcd");
  assert.equal(cleanName("x".repeat(40)).length, 16);
  assert.equal(cleanName(""), "");
  assert.equal(cleanName(null), "");
  assert.equal(cleanName({ toString: () => "sneaky" }), "");
});

test("everyone sees who joined; each player is told who they are", () => {
  const { host, join } = setup();
  const ada = join("p1", "Ada");
  const grace = join("p2", "Grace");
  assert.deepEqual(host.state.players.map((p: any) => p.name), ["Ada", "Grace"]);
  assert.equal(host.state.you, null);
  assert.deepEqual(ada.conn.state.you, { id: "p1", name: "Ada" });
  assert.deepEqual(grace.conn.state.you, { id: "p2", name: "Grace" });
  assert.equal(ada.conn.state.players.length, 2, "earlier players hear about later ones");
});

test("duplicate and blank names are made distinct", () => {
  const { join } = setup();
  assert.equal(join("p1", "Sam").member.name, "Sam");
  assert.equal(join("p2", "sam").member.name, "sam 2");
  assert.equal(join("p3", "SAM").member.name, "SAM 3");
  assert.equal(join("p4", "   ").member.name, "Player 4");
});

test("a returning player keeps their seat, even when the party is full", () => {
  const { session, sessions, join } = setup({ maxPlayers: 2 });
  const first = join("p1", "Ada");
  join("p2", "Grace");
  assert.throws(() => join("p3", "Linus"), (error: LobbyError) => error.code === "full");

  sessions.detach(session, first.conn);
  const back = join("p1", "Ada");
  assert.equal(back.member, first.member);
  assert.equal(session.members.size, 2);
});

test("a dropped connection shows as away, not gone", () => {
  const { session, sessions, host, join } = setup();
  const ada = join("p1", "Ada");
  sessions.detach(session, ada.conn);
  assert.deepEqual(host.state.players, [{ id: "p1", name: "Ada", connected: false }]);
  assert.equal(host.state.hostConnected, true);
});

test("launching tells everyone, with a ticket only they can use", async () => {
  const { session, sessions, host, join, runner } = setup();
  const ada = join("p1", "Ada");
  const grace = join("p2", "Grace");
  await sessions.launch(session, "trivia");

  const launch = runner.launches[0];
  assert.equal(host.of("state").some((s) => s.game?.status === "starting"), true);
  for (const conn of [host, ada.conn, grace.conn]) {
    assert.equal(conn.state.game.status, "running");
    assert.equal(conn.state.game.launchId, launch.id);
  }

  const claims = (url: string) => {
    const [path, ticket] = url.split("#t=");
    // The fake clock starts at zero, so check expiry against that, not today.
    return { path, claims: verifyTicket(launch.secret, ticket, { lid: launch.id, code: session.code }, 0) };
  };
  const forHost = claims(host.state.game.url);
  const forAda = claims(ada.conn.state.game.url);
  const forGrace = claims(grace.conn.state.game.url);
  assert.equal(forHost.path, `/g/${launch.id}/host`);
  assert.equal(forHost.claims?.role, "host");
  assert.equal(forAda.path, `/g/${launch.id}/play`);
  assert.deepEqual(
    [forAda.claims?.role, forAda.claims?.pid, forAda.claims?.name, forAda.claims?.gid],
    ["player", "p1", "Ada", "trivia"],
  );
  assert.equal(forGrace.claims?.pid, "p2");
  // The URL is stable across later state pushes, so the game iframe is not reloaded.
  const before = ada.conn.state.game.url;
  join("p3", "Linus");
  assert.equal(ada.conn.state.game.url, before);
});

test("an unknown game is refused", async () => {
  const { session, sessions } = setup();
  await assert.rejects(sessions.launch(session, "nope"), (error: LobbyError) => error.code === "unknown_game");
  await assert.rejects(sessions.launch(session, { id: "trivia" }), (error: LobbyError) => error.code === "unknown_game");
});

test("switching games stops the old one first", async () => {
  const { session, sessions, runner, host } = setup();
  await sessions.launch(session, "trivia");
  await sessions.launch(session, "draw");
  assert.deepEqual(runner.stopped, [runner.launches[0].id]);
  assert.equal(runner.running().length, 1);
  assert.equal(host.state.game.gameId, "draw");
});

test("a second launch while one is starting is refused", async () => {
  const { session, sessions, runner } = setup();
  let release!: () => void;
  runner.hold = new Promise((resolve) => (release = resolve));
  const first = sessions.launch(session, "trivia");
  await assert.rejects(sessions.launch(session, "draw"), (error: LobbyError) => error.code === "busy");
  release();
  await first;
  assert.equal(runner.running().length, 1);
});

test("closing while a game is still starting stops it once it is up", async () => {
  const { session, sessions, runner, host } = setup();
  let release!: () => void;
  runner.hold = new Promise((resolve) => (release = resolve));
  const launching = sessions.launch(session, "trivia");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.state.game.status, "starting");
  await sessions.closeGame(session, "host");
  assert.equal(host.state.game, null);
  release();
  await launching;
  assert.equal(runner.running().length, 0, "the late-arriving process must not be left running");
  assert.equal(host.state.game, null);
});

test("a failed start returns everyone to the lobby with an error", async () => {
  const { session, sessions, runner, host } = setup();
  runner.failNext = new Error("boom");
  await assert.rejects(sessions.launch(session, "trivia"), (error: LobbyError) => error.code === "game_failed");
  assert.equal(host.state.game, null);
  // The party is not stuck: the next launch works.
  await sessions.launch(session, "trivia");
  assert.equal(host.state.game.status, "running");
});

test("no free slot is reported as busy", async () => {
  const { session, sessions, runner } = setup();
  runner.failNext = new CapacityError();
  await assert.rejects(sessions.launch(session, "trivia"), (error: LobbyError) => error.code === "busy");
});

test("a crash returns everyone to the lobby and says so", async () => {
  const { session, sessions, runner, host, join } = setup();
  const ada = join("p1", "Ada");
  await sessions.launch(session, "trivia");
  runner.crash(runner.launches[0]);
  assert.equal(host.state.game, null);
  assert.equal(ada.conn.state.game, null);
  assert.deepEqual(host.of("error").at(-1), { type: "error", code: "game_crashed" });
});

test("a game with players connected is left alone", async () => {
  const { session, sessions, runner, clock, join } = setup({ idleMinutes: 15 });
  join("p1", "Ada");
  await sessions.launch(session, "trivia");
  for (let minute = 1; minute <= 120; minute++) {
    clock.now = minute * MINUTE;
    await sessions.sweep();
  }
  assert.equal(runner.running().length, 1);
});

test("a game is stopped once no player has been connected for the idle time", async () => {
  const { session, sessions, runner, clock, host, join } = setup({ idleMinutes: 15 });
  const ada = join("p1", "Ada");
  await sessions.launch(session, "trivia");

  clock.now = 10 * MINUTE;
  await sessions.sweep();
  sessions.detach(session, ada.conn); // last player leaves at 10:00

  clock.now = 24 * MINUTE;
  await sessions.sweep();
  assert.equal(runner.running().length, 1, "14 minutes without players: still running");

  clock.now = 26 * MINUTE;
  await sessions.sweep();
  assert.equal(runner.running().length, 0, "16 minutes without players: stopped");
  assert.equal(host.state.game, null);
  assert.deepEqual(host.of("notice").at(-1), { type: "notice", code: "idle" });
  // The projector is still open, so the party itself carries on.
  assert.equal(sessions.get(session.code), session);
});

test("launching alone gives the host the full idle allowance", async () => {
  const { session, sessions, runner, clock } = setup({ idleMinutes: 15 });
  clock.now = 60 * MINUTE; // the party has been open, playerless, for an hour
  await sessions.sweep();
  await sessions.launch(session, "trivia");
  clock.now = 74 * MINUTE;
  await sessions.sweep();
  assert.equal(runner.running().length, 1);
  clock.now = 76 * MINUTE;
  await sessions.sweep();
  assert.equal(runner.running().length, 0);
});

test("a game is stopped at its maximum lifetime even if people are playing", async () => {
  const { session, sessions, runner, clock, host, join } = setup({ maxGameMinutes: 60 });
  join("p1", "Ada");
  await sessions.launch(session, "trivia");
  clock.now = 59 * MINUTE;
  await sessions.sweep();
  assert.equal(runner.running().length, 1);
  clock.now = 61 * MINUTE;
  await sessions.sweep();
  assert.equal(runner.running().length, 0);
  assert.deepEqual(host.of("notice").at(-1), { type: "notice", code: "max_lifetime" });
});

test("a party nobody is connected to is ended, and its game with it", async () => {
  const { session, sessions, runner, clock, host, join } = setup({ idleMinutes: 15 });
  const ada = join("p1", "Ada");
  await sessions.launch(session, "trivia");
  sessions.detach(session, ada.conn);
  sessions.detach(session, host);
  clock.now = 16 * MINUTE;
  await sessions.sweep();
  assert.equal(sessions.get(session.code), undefined);
  assert.equal(runner.running().length, 0);
});

test("players who left long ago are forgotten between games, never during one", async () => {
  const { session, sessions, clock, join } = setup({ idleMinutes: 15 });
  const ada = join("p1", "Ada");
  join("p2", "Grace");
  await sessions.launch(session, "trivia");
  sessions.detach(session, ada.conn);
  clock.now = 30 * MINUTE;
  await sessions.sweep();
  assert.equal(session.members.has("p1"), true, "mid-game: seat and score are kept");

  await sessions.closeGame(session, "host");
  clock.now = 31 * MINUTE;
  await sessions.sweep();
  assert.equal(session.members.has("p1"), false);
  assert.equal(session.members.has("p2"), true);
});

test("ending the party says goodbye, disconnects everyone and stops the game", async () => {
  const { session, sessions, runner, host, join } = setup();
  const ada = join("p1", "Ada");
  await sessions.launch(session, "trivia");
  await sessions.end(session, "host");
  for (const conn of [host, ada.conn]) {
    assert.deepEqual(conn.of("bye"), [{ type: "bye", reason: "host" }]);
    assert.equal(conn.closed, true);
  }
  assert.equal(runner.running().length, 0);
  assert.equal(sessions.get(session.code), undefined);
});

test("renaming updates everyone and applies to the next game's ticket", async () => {
  const { session, sessions, runner, host, join } = setup();
  const ada = join("p1", "Ada");
  sessions.rename(session, ada.member, "Countess");
  assert.equal(host.state.players[0].name, "Countess");
  await sessions.launch(session, "trivia");
  const launch = runner.launches[0];
  const ticket = ada.conn.state.game.url.split("#t=")[1];
  assert.equal(verifyTicket(launch.secret, ticket, { lid: launch.id, code: session.code }, 0)?.name, "Countess");
});
