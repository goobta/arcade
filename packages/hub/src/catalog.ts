// The catalog is whatever is in the games folder: each subfolder with a valid
// game.json is a game. Nothing here names a specific game.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface GameManifest {
  id: string;
  name: string;
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
  /** argv, run with the game folder as the working directory. No shell. */
  start: string[];
  /** Absolute path, already checked to be inside the game folder. */
  thumbnail?: string;
  hostPath: string;
  playPath: string;
  healthPath: string;
  startTimeoutMs: number;
  maxHeapMb?: number;
  /** Names of hub environment variables this game is allowed to see. */
  env: string[];
  /** Absolute path of the game folder. */
  dir: string;
}

export interface Catalog {
  games: GameManifest[];
  /** Human-readable reasons folders were skipped. */
  problems: string[];
}

const ID = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SUBPATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Set by the runner for every game; a manifest cannot ask for the hub's value instead. */
export const RUNNER_ENV = ["PATH", "HOME", "PORT", "HOST", "BASE_PATH", "TZ", "NODE_ENV", "NODE_OPTIONS"];

function fail(message: string): never {
  throw new Error(message);
}

function text(value: unknown, field: string, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    fail(`"${field}" must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function count(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`"${field}" must be a whole number between ${min} and ${max}`);
  }
  return value as number;
}

function subpath(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !SUBPATH.test(value) || value.includes("..")) {
    fail(`"${field}" must be a relative path without ".."`);
  }
  return value;
}

/**
 * "env": the hub variables a game may read, by name. Everything under ARCADE_
 * is the hub's own (the host PIN above all) and can never be asked for.
 */
function envNames(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) fail(`"env" must be a list of at most 16 variable names`);
  const names: string[] = [];
  for (const name of value) {
    if (typeof name !== "string" || !ENV_NAME.test(name)) {
      fail(`"env" names must match ${ENV_NAME} (capitals, digits, underscores)`);
    }
    if (name.startsWith("ARCADE_")) fail(`"env" cannot include "${name}": ARCADE_ variables belong to the hub`);
    if (RUNNER_ENV.includes(name)) fail(`"env" cannot include "${name}": the hub sets it for every game`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Validates one parsed game.json. Throws with the reason when it is unusable. */
export function parseManifest(raw: unknown, dir: string): GameManifest | null {
  if (!raw || typeof raw !== "object") fail("game.json must be a JSON object");
  const m = raw as Record<string, unknown>;
  if (m.enabled === false) return null;
  if (m.manifest !== 1) fail(`"manifest" must be 1`);

  const folder = path.basename(dir);
  if (typeof m.id !== "string" || !ID.test(m.id)) {
    fail(`"id" must match ${ID} (lowercase letters, digits, dashes)`);
  }
  if (m.id !== folder) fail(`"id" ("${m.id}") must equal the folder name ("${folder}")`);

  if (
    !Array.isArray(m.start) ||
    m.start.length === 0 ||
    m.start.some((part) => typeof part !== "string" || part === "")
  ) {
    fail(`"start" must be a non-empty array of strings, e.g. ["node", "server.ts"]`);
  }

  const minPlayers = count(m.minPlayers, "minPlayers", 1, 1, 100);
  const maxPlayers = count(m.maxPlayers, "maxPlayers", 16, 1, 100);
  if (maxPlayers < minPlayers) fail(`"maxPlayers" must not be less than "minPlayers"`);

  let thumbnail: string | undefined;
  if (m.thumbnail !== undefined) {
    const relative = subpath(m.thumbnail, "thumbnail", "");
    const candidate = path.join(dir, relative);
    if (!existsSync(candidate)) fail(`thumbnail "${relative}" does not exist`);
    // Resolve symlinks so a link cannot point the hub at a file outside the game.
    const real = realpathSync(candidate);
    if (!real.startsWith(realpathSync(dir) + path.sep)) fail(`thumbnail must be inside the game folder`);
    thumbnail = real;
  }

  return {
    id: m.id,
    name: text(m.name, "name", 40),
    blurb: text(m.blurb, "blurb", 140, ""),
    minPlayers,
    maxPlayers,
    start: m.start as string[],
    thumbnail,
    hostPath: subpath(m.hostPath, "hostPath", "host"),
    playPath: subpath(m.playPath, "playPath", "play"),
    healthPath: subpath(m.healthPath, "healthPath", "healthz"),
    startTimeoutMs: count(m.startTimeoutMs, "startTimeoutMs", 15_000, 500, 120_000),
    maxHeapMb: m.maxHeapMb === undefined ? undefined : count(m.maxHeapMb, "maxHeapMb", 96, 32, 2048),
    env: envNames(m.env),
    dir,
  };
}

export function scanGames(gamesDir: string): Catalog {
  const games: GameManifest[] = [];
  const problems: string[] = [];
  if (!existsSync(gamesDir)) return { games, problems: [`games folder ${gamesDir} does not exist`] };

  for (const entry of readdirSync(gamesDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const dir = path.join(gamesDir, entry.name);
    const file = path.join(dir, "game.json");
    if (!existsSync(file)) continue; // not a game folder (or an uninitialised submodule)
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")), dir);
      if (manifest) games.push(manifest);
    } catch (error) {
      problems.push(`${entry.name}: ${(error as Error).message}`);
    }
  }
  games.sort((a, b) => a.name.localeCompare(b.name));
  return { games, problems };
}
