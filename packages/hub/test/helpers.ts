import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGames, type GameManifest } from "../src/catalog.ts";

export const FIXTURE_GAMES = fileURLToPath(new URL("./fixtures/games/", import.meta.url));

export function fixture(id: string): GameManifest {
  const game = scanGames(FIXTURE_GAMES).games.find((candidate) => candidate.id === id);
  if (!game) throw new Error(`no fixture game "${id}" in ${path.resolve(FIXTURE_GAMES)}`);
  return game;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}
