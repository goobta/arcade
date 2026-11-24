import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("defaults suit a small box: one game at a time, stopped after 15 idle minutes", () => {
  const config = loadConfig({ ARCADE_HOST_PIN: "123456" });
  assert.equal(config.port, 3000);
  assert.equal(config.maxGames, 1);
  assert.equal(config.idleMs, 15 * 60_000);
  assert.equal(config.maxGameMs, 4 * 3_600_000);
  assert.equal(config.maxPlayers, 16);
  assert.equal(config.publicUrl.origin, "http://localhost:3000");
  assert.match(config.gamesDir, /\/games$/);
});

test("the hub refuses to start without a real PIN", () => {
  assert.throws(() => loadConfig({}), /ARCADE_HOST_PIN/);
  assert.throws(() => loadConfig({ ARCADE_HOST_PIN: "" }), /ARCADE_HOST_PIN/);
  assert.throws(() => loadConfig({ ARCADE_HOST_PIN: "12345" }), /at least 6/);
});

test("settings are read from the environment and validated", () => {
  const config = loadConfig({
    ARCADE_HOST_PIN: "123456",
    PORT: "8080",
    PUBLIC_URL: "https://arcade.goobta.io",
    ARCADE_MAX_GAMES: "2",
    ARCADE_IDLE_MINUTES: "5",
    ARCADE_MAX_GAME_HOURS: "1",
    ARCADE_GAMES_DIR: "/srv/games",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.publicUrl.host, "arcade.goobta.io");
  assert.equal(config.maxGames, 2);
  assert.equal(config.idleMs, 5 * 60_000);
  assert.equal(config.maxGameMs, 3_600_000);
  assert.equal(config.gamesDir, "/srv/games");

  assert.throws(() => loadConfig({ ARCADE_HOST_PIN: "123456", ARCADE_MAX_GAMES: "lots" }), /ARCADE_MAX_GAMES/);
  assert.throws(() => loadConfig({ ARCADE_HOST_PIN: "123456", ARCADE_MAX_GAMES: "0" }), /ARCADE_MAX_GAMES/);
  assert.throws(() => loadConfig({ ARCADE_HOST_PIN: "123456", PUBLIC_URL: "not a url" }), /PUBLIC_URL/);
});
