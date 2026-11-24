// Plays a real party through the real hub in a real browser: one projector
// page and three phones, all the way to the scoreboard and back to the lobby.
//
// Needs Chromium for Playwright: `npx playwright install chromium` once on a
// fresh machine. Run with: npm run test:e2e
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PIN = "e2e-host-pin";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface TestHub {
  url: string;
  child: ChildProcess;
  output: string[];
}

async function startHub(env: Record<string, string> = {}): Promise<TestHub> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const child = spawn(process.execPath, ["packages/hub/src/main.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: url,
      ARCADE_HOST_PIN: PIN,
      ARCADE_PORT_BASE: String(await freePort()),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => output.push(String(chunk)));
  child.stderr!.on("data", (chunk) => output.push(String(chunk)));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return { url, child, output };
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`hub did not start:\n${output.join("")}`);
}

async function stopHub(hub: TestHub): Promise<void> {
  if (hub.child.exitCode !== null) return;
  hub.child.kill("SIGTERM");
  await new Promise((resolve) => hub.child.once("exit", resolve));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function openHost(hub: TestHub) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(`${hub.url}/host`);
  await page.locator("#pin").fill(PIN);
  await page.locator("#pin-form button").click();
  await page.locator("#room-code").filter({ hasText: /^[A-Z]{4}$/ }).waitFor();
  const code = (await page.locator("#room-code").textContent())!;
  return { context, page, code };
}

async function status(page: Page, hub: TestHub) {
  const response = await page.request.get(`${hub.url}/api/status`);
  return (await response.json()) as {
    sessions: { code: string; players: number; game: string | null }[];
    processes: { gameId: string; status: string; pid: number }[];
  };
}

test("a host and three phones play trivia, then switch to another game", { timeout: 120_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));

  // The PIN gate refuses a wrong PIN.
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(`${hub.url}/host`);
  await strangerPage.locator("#pin").fill("not-the-pin");
  await strangerPage.locator("#pin-form button").click();
  await strangerPage.locator("#pin-error").filter({ hasText: "not right" }).waitFor();
  assert.equal((await strangerPage.request.get(`${hub.url}/api/games`)).status(), 401);
  await stranger.close();

  const host = await openHost(hub);
  t.after(() => host.context.close());

  // Three phones join with the code from the projector.
  const names = ["Ada", "Grace", "Linus"];
  const phones = [];
  for (const name of names) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${hub.url}/${host.code}`);
    assert.equal(await page.locator("#code").inputValue(), host.code);
    await page.locator("#name").fill(name);
    await page.locator("#join-button").click();
    await page.locator("#lobby").filter({ hasText: `You're in, ${name}!` }).waitFor();
    phones.push({ name, page, game: page.frameLocator("#frame iframe") });
  }
  await host.page.locator("#players li").nth(2).waitFor();

  // An unknown code is refused.
  const lost = await browser.newContext();
  const lostPage = await lost.newPage();
  await lostPage.goto(`${hub.url}/`);
  await lostPage.locator("#code").fill("ZZZZ");
  await lostPage.locator("#name").fill("Nobody");
  await lostPage.locator("#join-button").click();
  await lostPage.locator("#join-error").filter({ hasText: "No party with that code" }).waitFor();
  await lost.close();

  // Nothing runs until the host opens a game.
  assert.deepEqual((await status(host.page, hub)).processes, []);

  await host.page.locator('.card[data-game="trivia"]').click();
  const stage = host.page.frameLocator("#stage iframe");
  await stage.locator("#start:not([disabled])").waitFor();
  for (const phone of phones) await phone.game.getByText("You're in!").waitFor();

  const running = await status(host.page, hub);
  assert.equal(running.processes.length, 1);
  assert.equal(running.processes[0].gameId, "trivia");
  const gamePid = running.processes[0].pid;
  assert.ok(alive(gamePid), "game process should be running");

  await stage.locator("#start").click();

  let reloadedScore: string | null = null;
  for (let round = 1; round <= 8; round++) {
    await stage.getByText(`Question ${round} of 8`).waitFor();
    // The projector never shows the answer while the question is open.
    assert.equal(await stage.locator(".choices .right").count(), 0);

    for (const [index, phone] of phones.entries()) {
      // Each phone always picks a different answer, so scores diverge.
      await phone.game.locator(`.pad button[data-choice="${index}"]`).click();
    }
    // Everyone answered: the game reveals without waiting for the timer.
    await stage.locator(".choices .right").waitFor();
    for (const phone of phones) await phone.game.locator("#result").waitFor();

    if (round === 2) {
      // A phone that reloads mid-game gets its seat and score back.
      const grace = phones[1];
      reloadedScore = await grace.game.locator(".top .score").textContent();
      await grace.page.reload();
      await grace.game.locator(".top .score").filter({ hasText: reloadedScore! }).waitFor();
      assert.equal(await host.page.locator("#stage iframe").count(), 1);
    }
    await stage.locator("#next").click();
  }

  await stage.getByText("wins!").waitFor();
  for (const phone of phones) await phone.game.locator("#place").waitFor();
  assert.equal(await stage.locator(".board li").count(), 3, "reload must not create a fourth player");

  // Back to the arcade: phones return to the lobby and the process is gone.
  await stage.getByRole("button", { name: "Back to arcade" }).click();
  await host.page.locator("#home").waitFor();
  for (const phone of phones) await phone.page.locator("#lobby").waitFor();
  assert.deepEqual((await status(host.page, hub)).processes, []);
  assert.equal(alive(gamePid), false, "game process should be gone after closing");

  // The same party opens a different game without anyone rejoining.
  await host.page.locator('.card[data-game="buzzer"]').click();
  await stage.locator("#open").click();
  await stage.getByText("Buzz!").waitFor();
  await phones[1].game.locator("#buzz").click();
  await stage.getByText("Grace got it!").waitFor();
  await phones[1].game.getByText("You got it!").waitFor();
  await phones[0].game.getByText("Too slow!").waitFor();
  await stage.getByText("Grace · 1").waitFor();
  const buzzer = await status(host.page, hub);
  assert.deepEqual(buzzer.processes.map((p) => p.gameId), ["buzzer"]);
  const second = buzzer.processes[0].pid;

  // Stopping the hub takes the game down with it.
  await stopHub(hub);
  assert.equal(alive(second), false, "game process should not outlive the hub");
});

test("a game nobody is playing is stopped after the idle timeout", { timeout: 60_000 }, async (t) => {
  const hub = await startHub({ ARCADE_IDLE_MINUTES: "0.05", ARCADE_SWEEP_SECONDS: "0.2" });
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  await host.page.locator('.card[data-game="trivia"]').click();
  await host.page.frameLocator("#stage iframe").locator("#start").waitFor();
  const { processes } = await status(host.page, hub);
  assert.equal(processes.length, 1);

  // No phones ever join. About three seconds later the hub closes the game.
  await host.page.locator("#home").waitFor({ timeout: 15_000 });
  await host.page.locator("#toast").filter({ hasText: "nobody was connected" }).waitFor();
  assert.deepEqual((await status(host.page, hub)).processes, []);
  assert.equal(alive(processes[0].pid), false);
});
