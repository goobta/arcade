import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  host: string;
  /** Where players are told to go, e.g. https://arcade.goobta.io */
  publicUrl: URL;
  hostPin: string;
  gamesDir: string;
  /** Game processes allowed to run at once. */
  maxGames: number;
  /** A game with no players connected for this long is stopped. */
  idleMs: number;
  /** A game is stopped after this long no matter what. */
  maxGameMs: number;
  /** V8 heap cap for each game process. */
  gameHeapMb: number;
  /** Games listen on portBase, portBase + 1, ... (loopback only). */
  portBase: number;
  maxPlayers: number;
  maxSessions: number;
  /** How often the idle policy runs. */
  sweepMs: number;
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hostPin = env.ARCADE_HOST_PIN ?? "";
  if (hostPin.length < 6) {
    throw new Error("ARCADE_HOST_PIN must be set to at least 6 characters");
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL (got "${env.PUBLIC_URL}")`);
  }

  return {
    port: int(env, "PORT", 3000, 0, 65535),
    host: env.HOST || "0.0.0.0",
    publicUrl,
    hostPin,
    gamesDir: path.resolve(env.ARCADE_GAMES_DIR || path.join(REPO_ROOT, "games")),
    maxGames: int(env, "ARCADE_MAX_GAMES", 1, 1, 16),
    idleMs: int(env, "ARCADE_IDLE_MINUTES", 15, 0.01, 24 * 60) * 60_000,
    maxGameMs: int(env, "ARCADE_MAX_GAME_HOURS", 4, 0.001, 48) * 3_600_000,
    gameHeapMb: int(env, "ARCADE_GAME_HEAP_MB", 96, 32, 2048),
    portBase: int(env, "ARCADE_PORT_BASE", 4100, 1024, 65000),
    maxPlayers: int(env, "ARCADE_MAX_PLAYERS", 16, 1, 100),
    maxSessions: int(env, "ARCADE_MAX_SESSIONS", 4, 1, 100),
    sweepMs: int(env, "ARCADE_SWEEP_SECONDS", 15, 0.05, 600) * 1000,
  };
}
