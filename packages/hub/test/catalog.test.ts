import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseManifest, scanGames } from "../src/catalog.ts";
import { FIXTURE_GAMES } from "./helpers.ts";

function gamesDir(games: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arcade-catalog-"));
  for (const [folder, manifest] of Object.entries(games)) {
    mkdirSync(path.join(dir, folder));
    if (manifest !== undefined) {
      writeFileSync(
        path.join(dir, folder, "game.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      );
    }
  }
  return dir;
}

const valid = (id: string, extra: object = {}) => ({
  manifest: 1,
  id,
  name: `Game ${id}`,
  start: ["node", "server.ts"],
  ...extra,
});

test("every folder with a valid game.json is a game, sorted by name", () => {
  const { games, problems } = scanGames(FIXTURE_GAMES);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    games.map((game) => game.id),
    ["crasher", "exits-early", "never-healthy", "ok", "slow", "stubborn"],
  );
});

test("defaults are filled in", () => {
  const dir = gamesDir({ quiz: valid("quiz") });
  const [game] = scanGames(dir).games;
  assert.equal(game.blurb, "");
  assert.equal(game.minPlayers, 1);
  assert.equal(game.maxPlayers, 16);
  assert.equal(game.hostPath, "host");
  assert.equal(game.playPath, "play");
  assert.equal(game.healthPath, "healthz");
  assert.equal(game.startTimeoutMs, 15_000);
  assert.equal(game.thumbnail, undefined);
  assert.equal(game.dir, path.join(dir, "quiz"));
});

test("broken games are skipped with a reason, and do not hide the good ones", () => {
  const dir = gamesDir({
    good: valid("good"),
    "wrong-id": valid("something-else"),
    "no-start": { manifest: 1, id: "no-start", name: "No start" },
    "bad-json": "{ not json",
    "future": valid("future", { manifest: 2 }),
    "shell-string": valid("shell-string", { start: "node server.ts" }),
    "upside-down": valid("upside-down", { minPlayers: 5, maxPlayers: 2 }),
    "escapes": valid("escapes", { hostPath: "../../etc/passwd" }),
    "no-manifest": undefined,
    ".hidden": valid(".hidden"),
    "_draft": valid("_draft"),
    "off": valid("off", { enabled: false }),
  });
  const { games, problems } = scanGames(dir);
  assert.deepEqual(games.map((game) => game.id), ["good"]);
  const reasons = Object.fromEntries(problems.map((p) => [p.slice(0, p.indexOf(":")), p]));
  assert.deepEqual(Object.keys(reasons).sort(), [
    "bad-json", "escapes", "future", "no-start", "shell-string", "upside-down", "wrong-id",
  ]);
  assert.match(reasons["wrong-id"], /must equal the folder name/);
  assert.match(reasons["no-start"], /"start" must be a non-empty array/);
  assert.match(reasons["upside-down"], /maxPlayers/);
  assert.match(reasons["escapes"], /hostPath/);
});

test("a thumbnail must exist and stay inside the game folder", () => {
  const dir = gamesDir({ pics: valid("pics", { thumbnail: "thumb.svg" }) });
  assert.match(scanGames(dir).problems[0], /does not exist/);

  writeFileSync(path.join(dir, "pics", "thumb.svg"), "<svg/>");
  assert.equal(scanGames(dir).games[0].thumbnail, path.join(dir, "pics", "thumb.svg"));

  // A symlink pointing outside the folder is refused.
  const outside = path.join(dir, "secret.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, path.join(dir, "pics", "link.svg"));
  const linked = parseManifestError(() =>
    parseManifest(valid("pics", { thumbnail: "link.svg" }), path.join(dir, "pics")),
  );
  assert.match(linked, /inside the game folder/);
});

function parseManifestError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

test("a missing games folder is reported, not fatal", () => {
  const { games, problems } = scanGames("/nonexistent/arcade/games");
  assert.deepEqual(games, []);
  assert.equal(problems.length, 1);
});
