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

test("a phone whose connections drop gets back into the game by itself", { timeout: 60_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  t.after(() => context.close());
  // Every websocket this phone opens goes through here, so the test can cut them.
  const sockets: { url: string; cut: () => void }[] = [];
  await context.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    sockets.push({
      url: ws.url(),
      cut: () => {
        void ws.close({ code: 1001 });
        void server.close({ code: 1001 });
      },
    });
  });
  const phone = await context.newPage();
  await phone.goto(`${hub.url}/${host.code}`);
  await phone.locator("#name").fill("Ada");
  await phone.locator("#join-button").click();
  await phone.locator("#lobby").waitFor();

  await host.page.locator('.card[data-game="trivia"]').click();
  const stage = host.page.frameLocator("#stage iframe");
  const game = phone.frameLocator("#frame iframe");
  await stage.locator("#start:not([disabled])").click();
  await game.locator(".pad button").first().waitFor();

  // What a phone going to sleep looks like from the server: both sockets die.
  const before = sockets.length;
  assert.equal(before, 2, "one lobby socket and one game socket");
  for (const socket of sockets) socket.cut();

  // Both come back without the player doing anything...
  for (let i = 0; i < 100 && sockets.length < before + 2; i++) await phone.waitForTimeout(100);
  const reopened = sockets.slice(before).map((socket) => new URL(socket.url).pathname);
  assert.ok(reopened.includes("/lobby"), "lobby reconnected");
  assert.ok(reopened.some((path) => path.startsWith("/g/")), "game reconnected");
  await phone.locator("#banner").waitFor({ state: "hidden" });
  await game.locator("#status").waitFor({ state: "hidden" });

  // ...and the answer they tap next still counts, in the same seat.
  await game.locator('.pad button[data-choice="0"]').click();
  await stage.locator(".choices .right").waitFor();
  await game.locator("#result").waitFor();
  assert.equal(await stage.locator(".board li").count(), 1);
});

/** Opens a lobby setting's menu on the projector and picks a value. */
async function setOption(stage: ReturnType<Page["frameLocator"]>, key: string, value: string | number) {
  await stage.locator(`[data-menu="${key}"]`).click();
  await stage.locator(`[data-set="${key}=${value}"]`).click();
}

test("three crews play Punchline: two answer, the third votes and heckles", { timeout: 120_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const names = ["Ada", "Grace", "Linus", "Alan"];
  const phones = [];
  for (const name of names) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${hub.url}/${host.code}`);
    await page.locator("#name").fill(name);
    await page.locator("#join-button").click();
    await page.locator("#lobby").waitFor();
    phones.push({ name, page, game: page.frameLocator("#frame iframe") });
  }
  const [ada, grace, linus, alan] = phones;

  await host.page.locator('.card[data-game="punchline"]').click();
  const stage = host.page.frameLocator("#stage iframe");

  // Both question packs in games/punchline/questions are offered.
  await stage.locator('[data-menu="pack"]').click();
  await stage.locator('[data-set="pack=party"]').waitFor();
  await stage.locator('[data-set="pack=work"]').waitFor();
  await stage.locator('[data-menu="pack"]').click();

  // Up to eight crews; this show has three, three rounds, two crews answering each (the default).
  await stage.locator('[data-menu="teams"]').click();
  assert.equal(await stage.locator('[data-set^="teams="]').count(), 7);
  await stage.locator('[data-set="teams=3"]').click();
  await setOption(stage, "rounds", 3);
  await stage.locator('.team[data-team="2"]').filter({ hasText: "Lemons" }).waitFor();
  assert.equal(await stage.locator("#start").isDisabled(), true, "cannot start with empty crews");

  // Ada: Hot Sauce. Grace: Blueberries. Linus and Alan: Lemons. Alan changes his mind first.
  await alan.game.locator('.crew[data-team="0"]').click();
  await stage.locator('.team[data-team="0"]').getByText("Alan").waitFor();
  await ada.game.locator('.crew[data-team="0"]').click();
  await grace.game.locator('.crew[data-team="1"]').click();
  await linus.game.locator('.crew[data-team="2"]').click();
  await alan.game.locator('.crew[data-team="2"]').click();
  await stage.locator('.team[data-team="2"]').getByText("Alan").waitFor();
  await alan.game.locator(".crew.picked").filter({ hasText: "Lemons" }).waitFor();
  await stage.locator("#start:not([disabled])").click();

  // Crews take turns: Hot Sauce+Blueberries, then Hot Sauce+Lemons, then Blueberries+Lemons.
  const rounds = [
    { writers: [ada, grace], voters: [linus, alan], winner: "Hot Sauce takes" },
    { writers: [ada, linus], voters: [grace], winner: "Lemons take" },
    { writers: [grace, alan], voters: [ada], winner: "Lemons take" },
  ];
  for (const [index, round] of rounds.entries()) {
    await stage.getByText(`ROUND ${index + 1} OF 3`).waitFor();
    for (const voter of round.voters) await voter.game.locator("#waiting").waitFor();

    const answers = round.writers.map((writer) => `${writer.name} says ${index}`);
    await round.writers[0].game.locator("#answer").fill(answers[0]);
    // The projector shows who is typing, not what.
    await stage.getByText(`${round.writers[0].name} is typing`).waitFor();
    if (index === 0) {
      // A judge heckles; it floats up the projector. A second tap straight away is ignored.
      await linus.game.locator('[data-heckle="HA!"]').click();
      await stage.locator("#fx .heckle").filter({ hasText: "Linus" }).waitFor();
      await linus.game.locator('[data-heckle="BOO"]').click();
      assert.equal(await stage.locator("#fx .heckle").filter({ hasText: "BOO" }).count(), 0);
    }
    await round.writers[0].game.locator("#send").click();
    await stage.getByText("1 of 2 answers in").waitFor();
    assert.equal(await stage.getByText(answers[0]).count(), 0);
    await round.writers[1].game.locator("#answer").fill(answers[1]);
    await round.writers[1].game.locator("#send").click();

    // Both answers are in: voting opens. The crews that wrote sit it out.
    await stage.locator(".answers li").nth(1).waitFor();
    for (const writer of round.writers) await writer.game.locator("#sitting-out").waitFor();
    const winning = round.winner.startsWith("Lemons") ? answers[1] : answers[0];
    for (const voter of round.voters) await voter.game.locator(".ballot button").filter({ hasText: winning }).click();

    // Everyone who can vote has: results show without waiting for the timer.
    await stage.locator(".results li.won").filter({ hasText: winning }).waitFor();
    await stage.getByText(`${round.winner} the round!`).waitFor();
    // The losing answer got no votes: crickets.
    await stage.locator(".results li:not(.won) .crickets").waitFor();
    for (const phone of phones) await phone.game.locator("#result").waitFor();
    await stage.locator("#next").click();
  }

  await stage.locator("#winner").filter({ hasText: "Lemons headline tonight!" }).waitFor();
  await stage.locator(".award").filter({ hasText: "BIGGEST ZINGER" }).waitFor();
  await stage.locator(".award").filter({ hasText: "THE CRICKETS AWARD" }).waitFor();
  await linus.game.locator("#place").filter({ hasText: "Your crew headlined!" }).waitFor();
  await ada.game.locator("#place").filter({ hasText: "placed 2 of 3" }).waitFor();
  await grace.game.locator("#place").filter({ hasText: "placed 3 of 3" }).waitFor();

  // New crews: back to the lobby, where Balance crews evens out a lopsided room.
  await stage.getByText("New crews").click();
  await stage.locator("#balance").waitFor();
  await setOption(stage, "teams", 2);
  // Lemons no longer exist, so Linus and Alan pick again; Balance places them.
  await stage.locator("#unassigned").getByText("Linus").waitFor();
  await stage.locator("#balance").click();
  await stage.locator('.team[data-team="0"] .members li').nth(1).waitFor();
  await stage.locator('.team[data-team="1"] .members li').nth(1).waitFor();
  assert.equal(await stage.locator("#unassigned").count(), 0);
});

test("two crews that both answer vote on everything in Punchline", { timeout: 60_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const phones = [];
  for (const name of ["Ada", "Grace", "Linus"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${hub.url}/${host.code}`);
    await page.locator("#name").fill(name);
    await page.locator("#join-button").click();
    await page.locator("#lobby").waitFor();
    phones.push({ name, page, game: page.frameLocator("#frame iframe") });
  }
  const [ada, grace, linus] = phones;

  await host.page.locator('.card[data-game="punchline"]').click();
  const stage = host.page.frameLocator("#stage iframe");
  await setOption(stage, "rounds", 3);
  await ada.game.locator('.crew[data-team="0"]').click();
  await grace.game.locator('.crew[data-team="1"]').click();
  await linus.game.locator('.crew[data-team="1"]').click();
  await stage.locator("#start:not([disabled])").click();

  // Typing survives the page being redrawn, and only one answer per crew counts.
  await grace.game.locator("#answer").fill("Blue answer");
  // Linus sees his teammate typing, and his own box is left alone.
  await linus.game.locator(".presence").getByText("Grace is typing").waitFor();
  await ada.game.locator("#answer").fill("Red answer");
  await ada.game.locator("#send").click();
  await ada.game.locator("#sent").filter({ hasText: "Red answer" }).waitFor();
  assert.equal(await grace.game.locator("#answer").inputValue(), "Blue answer");
  await grace.game.locator("#send").click();

  // No neutral crew exists, so all three vote, each for the other crew's answer.
  await stage.getByText("0 of 3 votes in").waitFor();
  await ada.game.locator(".ballot button").filter({ hasText: "Blue answer" }).click();
  await grace.game.locator(".ballot button").filter({ hasText: "Red answer" }).click();
  await linus.game.locator(".ballot button").filter({ hasText: "Red answer" }).click();
  await stage.getByText("Hot Sauce takes the round!").waitFor();
  await ada.game.locator("#result").filter({ hasText: "Your crew scored!" }).waitFor();
  await grace.game.locator("#result").filter({ hasText: "Hot Sauce scores" }).waitFor();
});
