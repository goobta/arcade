// Manage the games folder.
//
//   npm run games -- list                    what is installed, and from where
//   npm run games -- new <id> [name]         start a game from templates/game
//   npm run games -- add <git-url> [folder]  install a game repo as a submodule
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGames } from "../packages/hub/src/catalog.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GAMES = path.join(ROOT, "games");
const ID = /^[a-z0-9][a-z0-9-]{1,30}$/;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/** Folder (relative to the repo root) -> submodule URL. */
function submodules(): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(path.join(ROOT, ".gitmodules"))) return found;
  const lines = git("config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$")
    .trim()
    .split("\n")
    .filter(Boolean);
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const line of lines) {
    const [key, value] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    const field = key.endsWith(".path") ? "path" : "url";
    const name = key.slice("submodule.".length, -(field.length + 1));
    byName.set(name, { ...byName.get(name), [field]: value });
  }
  for (const entry of byName.values()) if (entry.path && entry.url) found.set(entry.path, entry.url);
  return found;
}

function list(): void {
  const { games, problems } = scanGames(GAMES);
  const sources = submodules();
  if (games.length === 0) console.log("No games installed.");
  for (const game of games) {
    const source = sources.get(`games/${game.id}`) ?? "in this repo";
    const players =
      game.minPlayers === game.maxPlayers ? `${game.minPlayers}` : `${game.minPlayers}-${game.maxPlayers}`;
    console.log(`${game.id.padEnd(20)} ${game.name.padEnd(24)} ${players.padEnd(6)} players   ${source}`);
  }
  for (const problem of problems) console.log(`! skipped ${problem}`);
  // A submodule that was never initialised has no game.json, so it is not above.
  for (const [folder, url] of sources) {
    if (folder.startsWith("games/") && !existsSync(path.join(ROOT, folder, "game.json"))) {
      console.log(`! ${folder} is not checked out (${url}). Run: git submodule update --init ${folder}`);
    }
  }
}

function create(id: string | undefined, name: string | undefined): void {
  if (!id || !ID.test(id)) fail(`Usage: games new <id> [name]\n<id> must match ${ID}`);
  const target = path.join(GAMES, id);
  if (existsSync(target)) fail(`games/${id} already exists`);
  cpSync(path.join(ROOT, "templates/game"), target, { recursive: true });

  const manifestFile = path.join(target, "game.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.id = id;
  manifest.name = name ?? id.replace(/(^|-)([a-z])/g, (_m, dash, letter) => (dash ? " " : "") + letter.toUpperCase());
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

  const packageFile = path.join(target, "package.json");
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  pkg.name = `arcade-game-${id}`;
  writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");

  console.log(`Created games/${id}. Run "npm run dev" and launch it from /host.`);
}

function add(url: string | undefined, folder: string | undefined): void {
  if (!url || url.startsWith("-")) fail("Usage: games add <git-url> [folder]");
  const guess = folder ?? path.basename(url).replace(/\.git$/, "").replace(/^arcade-(game-)?/, "");
  if (!ID.test(guess)) fail(`"${guess}" is not a valid game id. Pass a folder name: games add <git-url> <folder>`);
  if (existsSync(path.join(GAMES, guess))) fail(`games/${guess} already exists`);

  execFileSync("git", ["submodule", "add", "--", url, `games/${guess}`], { cwd: ROOT, stdio: "inherit" });

  const manifestFile = path.join(GAMES, guess, "game.json");
  if (!existsSync(manifestFile)) {
    fail(`Added games/${guess}, but it has no game.json, so the arcade will not list it.`);
  }
  // The folder must be named after the game's id for the hub to accept it.
  const id = JSON.parse(readFileSync(manifestFile, "utf8")).id;
  if (typeof id === "string" && ID.test(id) && id !== guess) {
    if (existsSync(path.join(GAMES, id))) fail(`The game's id is "${id}", but games/${id} already exists.`);
    execFileSync("git", ["mv", `games/${guess}`, `games/${id}`], { cwd: ROOT, stdio: "inherit" });
    console.log(`Moved to games/${id} to match the game's id.`);
  }
  list();
  console.log("\nCommit .gitmodules and the new folder to keep it.");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "list" || command === undefined) list();
else if (command === "new") create(rest[0], rest.slice(1).join(" ") || undefined);
else if (command === "add") add(rest[0], rest[1]);
else fail("Usage: games list | new <id> [name] | add <git-url> [folder]");
