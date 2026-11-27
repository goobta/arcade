// Plays a real party through the real hub in a real browser: one projector
// page and three phones, all the way to the scoreboard and back to the lobby.
//
// Needs Chromium for Playwright: `npx playwright install chromium` once on a
// fresh machine. Run with: npm run test:e2e
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PIN = "e2e-host-pin";

function probePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A port nothing is listening on. The hub refuses a game port base above
 * 65000, and the system hands out ports right up to 65535, so keep asking
 * until one is comfortably below that.
 */
async function freePort(): Promise<number> {
  for (;;) {
    const port = await probePort();
    if (port <= 64_900) return port;
  }
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

/** Phones that have joined the party and are waiting in the hub's lobby. */
async function joinPhones(t: TestContext, hub: TestHub, code: string, names: string[]) {
  const phones = [];
  for (const name of names) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(`${hub.url}/${code}`);
    await page.locator("#name").fill(name);
    await page.locator("#join-button").click();
    await page.locator("#lobby").waitFor();
    phones.push({ name, page, game: page.frameLocator("#frame iframe") });
  }
  return phones;
}

type Phone = Awaited<ReturnType<typeof joinPhones>>[number];

/** Types an answer and locks it in. */
async function lock(phone: Phone, text: string) {
  await phone.game.locator("#answer").fill(text);
  await phone.game.locator("#send").click();
  await phone.game.locator("#sent").filter({ hasText: text }).waitFor();
}

/** An answer on a phone's final ballot. */
const option = (phone: Phone, text: string) => phone.game.locator(".ballot .option").filter({ hasText: text });

test("three crews play Punchline: everyone writes, crews pick an answer, the room votes", { timeout: 120_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const phones = await joinPhones(t, hub, host.code, ["Ada", "Grace", "Linus", "Alan", "Tess"]);
  const [ada, grace, linus, alan, tess] = phones;

  await host.page.locator('.card[data-game="punchline"]').click();
  const stage = host.page.frameLocator("#stage iframe");

  // Both question packs in games/punchline/questions are offered. The hub has
  // no ANTHROPIC_API_KEY here, so the AI writer is not.
  await stage.locator('[data-menu="pack"]').click();
  await stage.locator('[data-set="pack=party"]').waitFor();
  await stage.locator('[data-set="pack=work"]').waitFor();
  assert.equal(await stage.locator('[data-set="pack=ai"]').count(), 0);
  await stage.locator('[data-menu="pack"]').click();

  // Crews and rounds are the only game-shape settings. Up to six crews; this show has three.
  assert.equal(await stage.locator('[data-menu="answering"]').count(), 0);
  await stage.locator('[data-menu="teams"]').click();
  assert.equal(await stage.locator('[data-set^="teams="]').count(), 5);
  await stage.locator('[data-set="teams=3"]').click();
  await setOption(stage, "rounds", 3);
  await stage.locator('.team[data-team="2"]').filter({ hasText: "Lemons" }).waitFor();
  assert.equal(await stage.locator("#start").isDisabled(), true, "cannot start with empty crews");

  // Ada and Grace: Hot Sauce. Linus and Alan: Blueberries. Tess: Lemons. Alan changes his mind first.
  await alan.game.locator('.crew[data-team="0"]').click();
  await stage.locator('.team[data-team="0"]').getByText("Alan").waitFor();
  await ada.game.locator('.crew[data-team="0"]').click();
  await grace.game.locator('.crew[data-team="0"]').click();
  await linus.game.locator('.crew[data-team="1"]').click();
  await tess.game.locator('.crew[data-team="2"]').click();
  await alan.game.locator('.crew[data-team="1"]').click();
  await stage.locator('.team[data-team="1"]').getByText("Alan").waitFor();
  await alan.game.locator(".crew.picked").filter({ hasText: "Blueberries" }).waitFor();
  await stage.locator("#start:not([disabled])").click();

  // ----- Round 1, crew stage: every crew writes -----
  await stage.getByText("ROUND 1 OF 3 · WRITE!").waitFor();
  assert.equal(await stage.locator(".writer").count(), 3);
  for (const phone of phones) await phone.game.locator("#answer").waitFor();

  // Typing shows to teammates and the projector as presence, never as words.
  await grace.game.locator("#answer").fill("Grace says");
  await stage.getByText("Grace is typing").waitFor();
  await ada.game.locator(".presence").getByText("Grace is typing").waitFor();
  await ada.game.locator("#answer").fill("Ada says");
  await grace.game.locator("#send").click();
  await grace.game.locator("#sent").filter({ hasText: "Grace says" }).waitFor();

  // A locked answer reaches teammates at once. Ada cannot back it until her own
  // is locked, and her half-typed answer survives the redraw.
  const graceOnAda = ada.game.locator('.mates [data-author]').filter({ hasText: "Grace says" });
  await graceOnAda.waitFor();
  assert.equal(await graceOnAda.isDisabled(), true);
  assert.equal(await ada.game.locator("#answer").inputValue(), "Ada says");
  // Other crews and the projector see progress only.
  await stage.locator('.writer[data-team="0"] [data-progress="1/2"]').waitFor();
  assert.equal(await stage.getByText("Grace says").count(), 0);
  assert.equal(await linus.game.getByText("Grace says").count(), 0);

  // Having locked, Grace can heckle while she waits; a second tap straight away is ignored.
  await grace.game.locator('[data-heckle="HA!"]').click();
  await stage.locator("#fx .heckle").filter({ hasText: "Grace" }).waitFor();
  await grace.game.locator('[data-heckle="BOO"]').click();
  assert.equal(await stage.locator("#fx .heckle").filter({ hasText: "BOO" }).count(), 0);

  await ada.game.locator("#send").click();
  await ada.game.locator("#sent").filter({ hasText: "Ada says" }).waitFor();
  // Your own answer is never among the ones you can back.
  assert.equal(await ada.game.locator(".mates [data-author]").count(), 1);
  assert.equal(await grace.game.locator(".mates [data-author]").count(), 1);

  // Grace votes early, while the clock still says WRITE. Ada sees the count move.
  await grace.game.locator(".timebar .left").filter({ hasText: "WRITE" }).waitFor();
  await grace.game.locator(".mates [data-author]").filter({ hasText: "Ada says" }).click();
  await grace.game.locator(".mates .picked .stamp").filter({ hasText: "YOUR PICK" }).waitFor();
  await stage.locator('.writer[data-team="0"]').getByText("1 crew vote").waitFor();

  // Blueberries back each other: a tie, so the first one locked goes up. Tess writes alone.
  await lock(linus, "Linus says");
  await lock(alan, "Alan says");
  await linus.game.locator(".mates [data-author]").filter({ hasText: "Alan says" }).click();
  await alan.game.locator(".mates [data-author]").filter({ hasText: "Linus says" }).click();
  await lock(tess, "Tess says");
  assert.equal(await tess.game.locator(".mates [data-author]").count(), 0);
  await stage.getByText("5 of 5 answers locked").waitFor();

  // Ada never votes, so the host moves things along. Ada's answer was locked
  // after Grace's but has the crew's only vote, so it is the one published.
  await stage.locator("#next").click();

  // ----- Round 1, final vote: every crew's answer, anonymous -----
  await stage.locator(".answers li").nth(2).waitFor();
  assert.equal(await stage.locator(".answers li").count(), 3);
  for (const text of ["Ada says", "Linus says", "Tess says"]) await stage.locator(".answers li").filter({ hasText: text }).waitFor();
  assert.equal(await stage.getByText("Grace says").count(), 0);

  // You cannot vote for the answer you wrote, but a teammate's is fair game.
  assert.equal(await option(ada, "Ada says").isDisabled(), true);
  await option(ada, "Ada says").getByText("Yours").waitFor();
  assert.equal(await option(grace, "Ada says").isDisabled(), false);
  await option(grace, "Ada says").getByText("Your crew's").waitFor();

  // Ada votes, then changes her mind.
  await option(ada, "Linus says").click();
  await option(ada, "Linus says").locator(".stamp").waitFor();
  await option(ada, "Tess says").click();
  await option(ada, "Tess says").locator(".stamp").waitFor();
  assert.equal(await ada.game.locator(".ballot .stamp").count(), 1);
  await stage.getByText("1 of 5 judges done").waitFor();

  for (const voter of [grace, linus, alan, tess]) await option(voter, "Ada says").click();

  // Everyone has voted: results show without waiting for the timer.
  await stage.locator(".results li.won").filter({ hasText: "Ada says" }).waitFor();
  await stage.getByText("Hot Sauce takes the round!").waitFor();
  await stage.locator('.result[data-team="0"]').getByText("4 votes").waitFor();
  await stage.locator('.result[data-team="2"]').getByText("1 vote").waitFor();
  // Nobody picked Blueberries' answer: crickets.
  await stage.locator('.result[data-team="1"] .crickets').waitFor();
  await ada.game.locator("#result").filter({ hasText: "Your crew scored!" }).waitFor();
  await linus.game.locator("#result").filter({ hasText: "Crickets." }).waitFor();
  await tess.game.locator("#result").filter({ hasText: "Hot Sauce scores" }).waitFor();
  await stage.locator("#next").click();

  // ----- Round 2: only Lemons lock an answer, so it scores unopposed -----
  await stage.getByText("ROUND 2 OF 3").waitFor();
  await lock(tess, "Tess again");
  await stage.locator("#next").click();
  await stage.getByText("Lemons score unopposed").waitFor();
  await stage.locator("#next").click();

  // ----- Round 3: nobody writes anything -----
  await stage.getByText("ROUND 3 OF 3").waitFor();
  await ada.game.locator("#answer").waitFor();
  await stage.locator("#next").click();
  await stage.getByText("Nobody scores. Tough crowd.").waitFor();
  await stage.locator("#next").click();

  await stage.locator("#winner").filter({ hasText: "It's a draw: Hot Sauce and Lemons share the bill!" }).waitFor();
  await stage.locator(".award").filter({ hasText: "BIGGEST ZINGER" }).filter({ hasText: "Ada says" }).waitFor();
  await stage.locator(".award").filter({ hasText: "THE CRICKETS AWARD" }).filter({ hasText: "Linus" }).waitFor();
  await ada.game.locator("#place").filter({ hasText: "A draw at the top!" }).waitFor();
  await linus.game.locator("#place").filter({ hasText: "placed 3 of 3" }).waitFor();

  // New crews: back to the lobby, where Balance crews evens out a lopsided room.
  await stage.getByText("New crews").click();
  await stage.locator("#balance").waitFor();
  await setOption(stage, "teams", 2);
  // Lemons no longer exist, so Tess picks again; Balance places her.
  await stage.locator("#unassigned").getByText("Tess").waitFor();
  await stage.locator("#balance").click();
  await stage.locator('.team[data-team="0"] .members li').nth(2).waitFor();
  await stage.locator('.team[data-team="1"] .members li').nth(1).waitFor();
  assert.equal(await stage.locator("#unassigned").count(), 0);
});

test("four crews in Punchline: two votes each, on two different answers", { timeout: 60_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const phones = await joinPhones(t, hub, host.code, ["Ada", "Grace", "Linus", "Alan"]);
  const [ada, grace, linus, alan] = phones;

  await host.page.locator('.card[data-game="punchline"]').click();
  const stage = host.page.frameLocator("#stage iframe");
  await setOption(stage, "teams", 4);
  await setOption(stage, "rounds", 3);
  for (const [index, phone] of phones.entries()) await phone.game.locator(`.crew[data-team="${index}"]`).click();
  await stage.locator("#start:not([disabled])").click();

  // One player per crew: with nobody to back, the crew stage ends as the last answer locks.
  for (const phone of [ada, grace, linus]) await lock(phone, `${phone.name} says`);
  await alan.game.locator("#answer").fill("Alan says");
  await alan.game.locator("#send").click();
  await stage.locator(".answers li").nth(3).waitFor();

  await ada.game.getByText("Pick your top 2").waitFor();
  await ada.game.locator("#votes-left").filter({ hasText: "Votes left: 2" }).waitFor();
  // Both votes cannot go on one answer: a second tap takes the first back.
  await option(ada, "Grace says").click();
  await ada.game.locator("#votes-left").filter({ hasText: "Votes left: 1" }).waitFor();
  await option(ada, "Grace says").click();
  await ada.game.locator("#votes-left").filter({ hasText: "Votes left: 2" }).waitFor();
  assert.equal(await ada.game.locator(".ballot .stamp").count(), 0);

  await option(ada, "Grace says").click();
  await ada.game.locator("#votes-left").filter({ hasText: "Votes left: 1" }).waitFor();
  await option(ada, "Linus says").click();
  await ada.game.locator("#votes-left").filter({ hasText: "Votes are in!" }).waitFor();
  assert.equal(await ada.game.locator(".ballot .stamp").count(), 2);
  await stage.getByText("1 of 4 judges done").waitFor();

  const picks: [Phone, string[]][] = [
    [grace, ["Ada says", "Linus says"]],
    [linus, ["Ada says", "Grace says"]],
    [alan, ["Ada says", "Grace says"]],
  ];
  for (const [phone, texts] of picks) {
    await option(phone, texts[0]).click();
    await phone.game.locator("#votes-left").filter({ hasText: "Votes left: 1" }).waitFor();
    await option(phone, texts[1]).click();
  }

  // Both of each player's votes are counted: Ada 3, Grace 3, Linus 2, Alan 0.
  await stage.getByText("A tie: Hot Sauce and Blueberries each score").waitFor();
  await stage.locator('.result[data-team="0"]').getByText("3 votes").waitFor();
  await stage.locator('.result[data-team="1"]').getByText("3 votes").waitFor();
  await stage.locator('.result[data-team="2"]').getByText("2 votes").waitFor();
  await stage.locator('.result[data-team="3"] .crickets').waitFor();
});

test("six crews in Punchline: six lanes, and shuffling fills them all", { timeout: 60_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const phones = await joinPhones(t, hub, host.code, ["Ada", "Grace", "Linus", "Alan", "Tess", "Ken"]);
  await host.page.locator('.card[data-game="punchline"]').click();
  const stage = host.page.frameLocator("#stage iframe");
  await setOption(stage, "teams", 6);

  // More than four crews: the lobby switches to one lane per crew, and phones get six to pick from.
  for (let crew = 0; crew < 6; crew++) await stage.locator(`.lane[data-team="${crew}"]`).first().waitFor();
  assert.equal(await stage.locator('.lane[data-team="6"]').count(), 0);
  assert.equal(await phones[0].game.locator(".crew").count(), 6);
  assert.equal(await stage.locator("#start").isDisabled(), true);

  await stage.locator("#shuffle").click();
  for (let crew = 0; crew < 6; crew++) {
    await stage.locator(`.lane[data-team="${crew}"] .count`).first().filter({ hasText: /^1$/ }).waitFor();
  }
  await stage.locator("#start:not([disabled])").click();
  await stage.locator(".writer").nth(5).waitFor();
  assert.equal(await stage.locator(".writer").count(), 6);
});

test("Punchline's guest of honour: takes the seat, watches, and their vote counts three", { timeout: 60_000 }, async (t) => {
  const hub = await startHub();
  t.after(() => stopHub(hub));
  const host = await openHost(hub);
  t.after(() => host.context.close());

  const phones = await joinPhones(t, hub, host.code, ["Raju", "Ada", "Grace", "Linus"]);
  const [raju, ada, grace, linus] = phones;

  await host.page.locator('.card[data-game="punchline"]').click();
  const stage = host.page.frameLocator("#stage iframe");
  // The usual packs have no seat; the Raju's 60th pack does.
  await ada.game.locator('.crew[data-team="0"]').waitFor();
  assert.equal(await ada.game.locator("#vip-seat").count(), 0);
  await setOption(stage, "pack", "raju-60th");
  await setOption(stage, "rounds", 3);
  await stage.locator("#vip").filter({ hasText: "Birthday Boy: seat open" }).waitFor();

  // One seat: Raju takes it, and it is gone from everyone else's phone.
  await raju.game.locator("button#vip-seat").click();
  await raju.game.getByText("You're the Birthday Boy!").waitFor();
  await raju.game.locator('#watch[aria-pressed="true"]').waitFor();
  await ada.game.locator("p#vip-seat").filter({ hasText: "Birthday Boy: Raju" }).waitFor();
  assert.equal(await ada.game.locator("#watch").count(), 0);
  await stage.locator("#vip").filter({ hasText: "Birthday Boy: Raju · watching · votes ×3" }).waitFor();

  // He can sit on a crew instead, and go back to watching.
  await raju.game.locator('.crew[data-team="1"]').click();
  await stage.locator('.team[data-team="1"] li.vip').filter({ hasText: "Raju" }).waitFor();
  await stage.locator("#vip").filter({ hasText: "Raju · Kulfis" }).waitFor();
  await raju.game.locator("#watch").click();
  await stage.locator("#vip").filter({ hasText: "Raju · watching" }).waitFor();

  await ada.game.locator('.crew[data-team="0"]').click();
  await grace.game.locator('.crew[data-team="0"]').click();
  await linus.game.locator('.crew[data-team="1"]').click();
  await stage.locator('.team[data-team="1"]').getByText("Linus").waitFor();
  assert.equal(await stage.locator("#unassigned").count(), 0, "a watching guest is not still choosing");
  await stage.locator("#start:not([disabled])").click();

  // The crews write. Raju has nothing to write, and can heckle from the first second.
  await raju.game.locator("#spectating").waitFor();
  assert.equal(await raju.game.locator("#answer").count(), 0);
  await raju.game.locator('[data-heckle="HA!"]').click();
  await host.page.locator("#stage iframe").contentFrame().locator(".heckle").filter({ hasText: "Raju" }).waitFor();
  await lock(ada, "Ada says");
  await lock(grace, "Grace says");
  await lock(linus, "Linus says");
  await ada.game.locator(".mates .option").click();
  await grace.game.locator(".mates .option").click();

  // The final vote: Raju is first among the judges before he has voted, and his pick is worth three.
  await stage.locator(".votes-in li.vip.waiting").filter({ hasText: "Raju" }).waitFor();
  await raju.game.locator("#votes-left").filter({ hasText: "It counts ×3" }).waitFor();
  await option(ada, "Linus says").click();
  await option(grace, "Ada says").click();
  await option(linus, "Ada says").click();
  await stage.getByText("3 of 4 judges done").waitFor();
  await option(raju, "Linus says").click();

  // Two voters for Ada's, two for Linus's, but one of those is Raju: 2 against 4.
  await stage.locator('.result[data-team="1"].won').getByText("4 votes").waitFor();
  await stage.locator('.result[data-team="1"] .voters li.vip .times').filter({ hasText: "×3" }).waitFor();
  await stage.locator('.result[data-team="0"]').getByText("2 votes").waitFor();
  await raju.game.locator("#result").filter({ hasText: "Kulfis score" }).waitFor();
  await linus.game.getByText("4 of 6 votes").waitFor();
});
