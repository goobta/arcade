import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { CapacityError, Runner, type Launch } from "../src/runner.ts";
import { alive, fixture, freePort, until } from "./helpers.ts";

const info = { code: "BCDF", maxPlayers: 8 };
const runners: Runner[] = [];

async function runner(overrides: { maxGames?: number; killAfterMs?: number } = {}): Promise<Runner> {
  const created = new Runner({
    maxGames: 2,
    portBase: await freePort(),
    heapMb: 64,
    publicUrl: "http://arcade.test",
    log: () => {},
    ...overrides,
  });
  runners.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map((created) => created.stopAll()));
});

test("launch resolves once the game is healthy, and stop removes the process", async () => {
  const r = await runner();
  const launch = await r.launch(fixture("ok"), info);
  assert.equal(launch.status, "running");
  assert.ok(alive(launch.pid));
  assert.equal(r.get(launch.id), launch);

  const exit = once(r, "exit");
  await r.stop(launch.id);
  const [exited, detail] = (await exit) as [Launch, { expected: boolean }];
  assert.equal(exited.id, launch.id);
  assert.equal(detail.expected, true);
  assert.equal(alive(launch.pid), false);
  assert.equal(r.get(launch.id), undefined);
  assert.deepEqual(r.list(), []);
});

test("a game gets the launch details but none of the hub's own environment", async () => {
  process.env.ARCADE_HOST_PIN = "do-not-leak-me";
  process.env.SOME_OTHER_SECRET = "nor-me";
  const r = await runner();
  const launch = await r.launch(fixture("ok"), info);
  const env = (await (await fetch(`http://127.0.0.1:${launch.port}/env`)).json()) as Record<string, string>;

  assert.equal(env.ARCADE_HOST_PIN, undefined);
  assert.equal(env.SOME_OTHER_SECRET, undefined);
  assert.equal(env.PORT, String(launch.port));
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.ARCADE_CODE, "BCDF");
  assert.equal(env.ARCADE_LAUNCH_ID, launch.id);
  assert.equal(env.ARCADE_SECRET, launch.secret);
  assert.equal(env.ARCADE_GAME_ID, "ok");
  assert.equal(env.BASE_PATH, `/g/${launch.id}`);
  assert.equal(env.ARCADE_MAX_PLAYERS, "8");
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=64/);
});

test("each launch gets its own id and secret", async () => {
  const r = await runner();
  const first = await r.launch(fixture("ok"), info);
  const second = await r.launch(fixture("ok"), info);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.secret, second.secret);
  assert.notEqual(first.port, second.port);
});

test("a slow starter is waited for", async () => {
  const r = await runner();
  const launch = await r.launch(fixture("slow"), info);
  assert.equal(launch.status, "running");
  assert.ok(Date.now() - launch.startedAt >= 500);
});

test("a game that never becomes healthy is killed and its slot freed", async () => {
  const r = await runner({ maxGames: 1 });
  let reported = false;
  r.on("exit", () => (reported = true));
  await assert.rejects(r.launch(fixture("never-healthy"), info), /not healthy after 1500 ms/);
  assert.deepEqual(r.list(), []);
  assert.equal(reported, false, "a failed start is reported by the rejection only");
  // The slot is usable again.
  const next = await r.launch(fixture("ok"), info);
  assert.equal(next.status, "running");
});

test("a game that exits during startup rejects the launch", async () => {
  const r = await runner();
  await assert.rejects(r.launch(fixture("exits-early"), info), /exited before becoming healthy/);
  assert.deepEqual(r.list(), []);
});

test("a command that does not exist rejects the launch", async () => {
  const r = await runner();
  const missing = { ...fixture("ok"), start: ["definitely-not-a-real-command"] };
  await assert.rejects(r.launch(missing, info), /could not start/);
  assert.deepEqual(r.list(), []);
});

test("a crash after startup is reported as unexpected", async () => {
  const r = await runner();
  const exit = once(r, "exit");
  const launch = await r.launch(fixture("crasher"), info);
  const [exited, detail] = (await exit) as [Launch, { expected: boolean }];
  assert.equal(exited.id, launch.id);
  assert.equal(detail.expected, false);
  assert.equal(r.get(launch.id), undefined);
});

test("a game that ignores SIGTERM is killed after the grace period", async () => {
  const r = await runner({ killAfterMs: 200 });
  const launch = await r.launch(fixture("stubborn"), info);
  const started = Date.now();
  await r.stop(launch.id);
  const took = Date.now() - started;
  assert.ok(took >= 150 && took < 2000, `stop took ${took} ms`);
  assert.equal(alive(launch.pid), false);
});

test("launching beyond capacity is refused until a slot frees up", async () => {
  const r = await runner({ maxGames: 1 });
  const first = await r.launch(fixture("ok"), info);
  await assert.rejects(r.launch(fixture("ok"), info), CapacityError);
  await r.stop(first.id);
  const second = await r.launch(fixture("ok"), info);
  assert.equal(second.port, first.port, "the freed slot's port is reused");
});

test("stopAll stops everything, and stopping twice is harmless", async () => {
  const r = await runner();
  const a = await r.launch(fixture("ok"), info);
  const b = await r.launch(fixture("ok"), info);
  await Promise.all([r.stopAll(), r.stop(a.id)]);
  await until(() => !alive(a.pid) && !alive(b.pid));
  await r.stop("no-such-launch");
  assert.deepEqual(r.list(), []);
});
