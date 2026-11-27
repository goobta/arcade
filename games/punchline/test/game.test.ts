// Drives Punchline's rules directly, with a stand-in for the SDK's `g`, so the
// crew stage, the final vote, heckles, balancing, awards and the AI prompt
// flow are checked without a browser.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Game, Player } from "@arcade/sdk";
import {
  CREWS,
  aiRounds,
  parsePack,
  THEMES,
  HECKLES_PER_SECOND,
  TEAM_MS,
  WRITE_MS,
  createDefinition,
  type Options,
  type Pack,
  type PromptRequest,
  type State,
} from "../game.ts";

const PACKS: Pack[] = [
  { id: "test", name: "Test", description: "", theme: null, vip: null, prompts: Array.from({ length: 20 }, (_, i) => `Prompt ${i + 1}`) },
  { id: "party", name: "Raju's 60th", description: "", theme: "raju60", vip: { title: "Birthday Boy", votes: 3 }, prompts: Array.from({ length: 20 }, (_, i) => `Roast ${i + 1}`) },
];

interface Seat extends Player {
  connected: boolean;
}

function party(count: number, options: Options = {}) {
  const def = createDefinition(PACKS, { aiAvailable: false, ...options });
  const players: Seat[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, connected: true }));
  const timers = new Map<string, { at: number; fn: () => void }>();
  const sent: { to: unknown; type: string; data: any }[] = [];
  let syncs = 0;
  const g: Game<State> = {
    state: def.init({ code: "FROG", maxPlayers: 100 }),
    code: "FROG",
    players,
    hostConnected: true,
    timer: (name, ms, fn) => void timers.set(name, { at: Date.now() + ms, fn }),
    clearTimer: (name) => void timers.delete(name),
    deadline: (name) => timers.get(name)?.at,
    send: (to, type, data) => void sent.push({ to, type, data }),
    broadcast: () => {},
    sync: () => void syncs++,
    end: () => {},
  };
  return {
    g,
    players,
    sent,
    syncs: () => syncs,
    host: (type: string, data?: unknown) => def.onHost![type](g, data),
    play: (who: number, type: string, data?: unknown) => def.onPlayer![type](g, players[who], data),
    leave: (who: number) => {
      players[who].connected = false;
      def.onLeave!(g, players[who]);
    },
    /** Runs a timer as if its time had come. */
    fire: (name: string) => {
      const timer = timers.get(name);
      assert.ok(timer, `no "${name}" timer is running`);
      timers.delete(name);
      timer.fn();
    },
    timers: () => [...timers.keys()].sort(),
    hostView: () => def.hostView(g) as any,
    view: (who: number) => def.playerView(g, players[who]) as any,
  };
}

type Party = ReturnType<typeof party>;

/** Players 0..n-1 join the crews listed. */
function seat(p: Party, crews: number[]) {
  crews.forEach((crew, who) => p.play(who, "join", crew));
}

/** Where a crew's answer sits on the shuffled ballot. */
const slot = (p: Party, crew: number) => p.g.state.ballot.indexOf(crew);

const sizes = (p: Party) => p.hostView().teams.map((team: any) => team.members.length);

/** Lets promise callbacks (the AI answer arriving) run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test("up to six crews, named, and no more", () => {
  const p = party(2);
  p.host("configure", { teams: 6 });
  assert.deepEqual(
    p.hostView().teams.map((team: any) => team.name),
    CREWS,
  );
  assert.equal(CREWS.length, 6);
  p.host("configure", { teams: 7 });
  assert.equal(p.g.state.config.teams, 6);
  p.play(0, "join", 6);
  assert.equal(p.view(0).team, null);
  p.play(0, "join", 5);
  assert.equal(p.view(0).teamName, "Tangerines");
  // Dropping to fewer crews sends their members back to the picker.
  p.host("configure", { teams: 4 });
  assert.equal(p.view(0).team, null);
});

test("a pack's theme dresses the show only while that pack is chosen", () => {
  const p = party(2, { aiAvailable: true });
  assert.equal(p.hostView().theme, null);
  assert.equal(p.view(0).theme, null);
  assert.deepEqual(p.hostView().packs.map((pack: any) => pack.theme), [null, "raju60"]);

  p.host("configure", { pack: "party", teams: 6 });
  assert.equal(p.hostView().theme, "raju60");
  assert.equal(p.view(0).theme, "raju60");
  assert.deepEqual(p.hostView().teams.map((team: any) => team.name), THEMES.raju60.crews);
  p.play(0, "join", 1);
  assert.equal(p.view(0).teamName, "Kulfis");

  // AI prompts and other packs go back to the usual stage and names.
  p.host("configure", { source: "ai" });
  assert.equal(p.hostView().theme, null);
  p.host("configure", { source: "pack" });
  assert.equal(p.hostView().theme, "raju60");
  p.host("configure", { pack: "test" });
  assert.equal(p.hostView().theme, null);
  assert.deepEqual(p.hostView().teams.map((team: any) => team.name), CREWS);
  assert.equal(p.view(0).teamName, "Blueberries");
});

test("a pack file may name a theme, and an unknown one is dropped", () => {
  assert.equal(parsePack("a", { prompts: ["x"] }).theme, null);
  assert.equal(parsePack("a", { theme: "raju60", vip: { title: "Birthday Boy", votes: 3 }, prompts: ["x"] }).theme, "raju60");
  assert.equal(parsePack("a", { theme: "disco", prompts: ["x"] }).theme, null);
  assert.equal(parsePack("a", { theme: "constructor", prompts: ["x"] }).theme, null);
});

test("balance crews moves the fewest people and places stragglers", () => {
  const p = party(12);
  p.host("configure", { teams: 3 });
  // Seven on Hot Sauce, one on Blueberries, none on Lemons, four still choosing.
  seat(p, [0, 0, 0, 0, 0, 0, 0, 1]);
  p.host("balance");
  assert.deepEqual(sizes(p), [4, 4, 4]);
  // The first three to join Hot Sauce stay put; only later arrivals moved.
  for (const who of [0, 1, 2, 3]) assert.equal(p.g.state.teamOf[`p${who}`], 0);
  assert.equal(p.hostView().unassigned.length, 0);
});

test("balance ignores phones that have gone home", () => {
  const p = party(6);
  seat(p, [0, 0, 0, 0, 1, 1]);
  p.leave(2);
  p.leave(3);
  p.host("balance");
  // Two live players each side already: nobody moves, the absent stay where they were.
  assert.deepEqual(
    p.players.map((player) => p.g.state.teamOf[player.id]),
    [0, 0, 0, 0, 1, 1],
  );
});

test("stragglers join the smallest crew when the curtain goes up", () => {
  const p = party(5);
  seat(p, [0, 0, 1]);
  p.host("start");
  assert.equal(p.g.state.phase, "team");
  // Blueberries had one, so the first straggler evens it up and the second goes to Hot Sauce.
  assert.equal(p.g.state.teamOf.p3, 1);
  assert.equal(p.g.state.teamOf.p4, 0);
});

test("crew stage: everyone writes, locked answers show to teammates only, and nobody backs their own", () => {
  const p = party(5);
  p.host("configure", { teams: 3 });
  seat(p, [0, 0, 0, 1, 2]);
  p.host("start");
  assert.deepEqual(p.timers(), ["team", "write"]);
  assert.equal(p.view(0).duration, TEAM_MS);
  assert.equal(p.view(0).deadline - p.view(0).writeDeadline, TEAM_MS - WRITE_MS);
  // Every crew writes every round: nobody sits out.
  for (const who of [0, 3, 4]) assert.equal(p.view(who).huddle.writeOpen, true);

  p.play(0, "answer", "  Gym   Sock Sorbet ");
  p.play(0, "answer", "A second thought");
  assert.equal(p.view(0).huddle.mine, "Gym Sock Sorbet", "one answer each, tidied, no take-backs");

  // A teammate sees it the moment it is locked; other crews and the projector never do.
  assert.deepEqual(p.view(1).huddle.answers, [
    { id: "p0", text: "Gym Sock Sorbet", byName: "Player 0", votes: 0, mine: false, picked: false },
  ]);
  assert.deepEqual(p.view(3).huddle.answers, []);
  assert.equal(JSON.stringify(p.view(3)).includes("Gym Sock"), false);
  assert.equal(JSON.stringify(p.hostView()).includes("Gym Sock"), false);
  assert.deepEqual([p.hostView().teams[0].locked, p.hostView().teams[0].writers], [1, 3]);
  assert.equal(p.hostView().lockedIn, 1);

  // Voting opens for you once your own answer is locked.
  assert.equal(p.view(1).huddle.canVote, false);
  p.play(1, "teamVote", "p0");
  assert.deepEqual(p.g.state.teamVotes, {});
  p.play(1, "answer", "Nana's Couch Cushion");
  assert.equal(p.view(1).huddle.canVote, true);

  // Never your own, never another crew's, never someone who has not locked.
  p.play(0, "teamVote", "p0");
  p.play(0, "teamVote", "p3");
  p.play(0, "teamVote", "p2");
  assert.deepEqual(p.g.state.teamVotes, {});

  p.play(0, "teamVote", "p1");
  p.play(2, "answer", "Regret");
  // A vote can be changed until the clock runs out.
  p.play(2, "teamVote", "p0");
  assert.equal(p.view(2).huddle.myVote, "p0");
  p.play(2, "teamVote", "p1");
  assert.deepEqual(p.g.state.teamVotes, { p0: "p1", p2: "p1" });
  assert.deepEqual(
    p.view(0).huddle.answers.map((a: any) => [a.byName, a.votes, a.mine, a.picked]),
    [
      ["Player 0", 0, true, false],
      ["Player 1", 2, false, true],
      ["Player 2", 0, false, false],
    ],
  );
  assert.equal(p.hostView().teams[0].teamVotes, 2);
  assert.equal(p.hostView().teams[0].submitted, true);

  // The solo crews have nobody to back. Once the last vote is in, the stage ends early.
  p.play(3, "answer", "Solo one");
  p.play(4, "answer", "Solo two");
  assert.equal(p.g.state.phase, "team", "still waiting on Player 1's vote");
  p.play(1, "teamVote", "p2");
  assert.equal(p.g.state.phase, "vote");
  assert.deepEqual(p.timers(), ["vote"]);
  assert.deepEqual(p.g.state.answers[0], { text: "Nana's Couch Cushion", by: "Player 1", byId: "p1" });
  assert.equal(p.g.state.answers[1].text, "Solo one");
});

test("crew stage: the last five seconds are voting only, ties go to the first lock, and a silent crew sits out", () => {
  const p = party(4);
  seat(p, [0, 0, 0, 1]);
  p.host("start");
  p.play(1, "answer", "Second in, by name; first in, by clock");
  p.play(0, "answer", "Locked later");

  p.fire("write");
  assert.equal(p.view(2).huddle.writeOpen, false);
  p.play(2, "answer", "Too late");
  assert.equal(p.view(2).huddle.mine, null);
  // Out of time to write, but still in time to vote.
  assert.equal(p.view(2).huddle.canVote, true);
  p.play(0, "teamVote", "p1");
  p.play(1, "teamVote", "p0");
  assert.equal(p.g.state.phase, "team", "Player 2 has not voted, so the clock keeps running");

  p.fire("team");
  // One vote each: the answer locked first goes up. Blueberries locked nothing,
  // so Hot Sauce is alone on the ballot and scores unopposed.
  assert.equal(p.g.state.answers[0].byId, "p1");
  assert.equal(1 in p.g.state.answers, false);
  assert.equal(p.g.state.phase, "result");
  assert.equal(p.hostView().unopposed, true);
  assert.deepEqual(p.g.state.scores, [1, 0]);
  assert.deepEqual(
    p.hostView().results.map((r: any) => [r.name, r.text === null, r.won]),
    [
      ["Hot Sauce", false, true],
      ["Blueberries", true, false],
    ],
  );
});

test("crew stage: a phone going home does not hold the room up", () => {
  const p = party(3);
  seat(p, [0, 0, 1]);
  p.host("start");
  p.play(0, "answer", "Here");
  p.play(2, "answer", "Also here");
  assert.equal(p.g.state.phase, "team");
  p.leave(1);
  assert.equal(p.g.state.phase, "vote");
});

test("final vote with three crews: one vote, any answer but the one you wrote, changeable until all are in", () => {
  const p = party(5);
  p.host("configure", { teams: 3 });
  seat(p, [0, 0, 1, 1, 2]);
  p.host("start");
  p.play(0, "answer", "Zero");
  p.play(1, "answer", "One");
  p.play(2, "answer", "Two");
  p.play(3, "answer", "Three");
  p.play(4, "answer", "Four");
  p.play(0, "teamVote", "p1");
  p.play(1, "teamVote", "p0");
  p.play(2, "teamVote", "p3");
  p.play(3, "teamVote", "p2");
  assert.equal(p.g.state.phase, "vote");
  // Tied crew votes: the earlier lock was published.
  assert.deepEqual([p.g.state.answers[0].byId, p.g.state.answers[1].byId, p.g.state.answers[2].byId], ["p0", "p2", "p4"]);
  // Every crew's answer is up, and the ballot says nothing about who wrote what.
  assert.deepEqual([...p.hostView().ballot].sort(), ["Four", "Two", "Zero"]);
  assert.equal(p.hostView().votesEach, 1);
  assert.equal(p.hostView().voters, 5);

  const mine = (who: number, crew: number) => p.view(who).voting.options[slot(p, crew)];
  assert.deepEqual([mine(0, 0).yours, mine(0, 0).allowed, mine(0, 0).own], [true, false, true]);
  // A teammate's answer is your crew's, but you did not write it: fair game.
  assert.deepEqual([mine(1, 0).yours, mine(1, 0).allowed, mine(1, 0).own], [false, true, true]);
  assert.equal(p.view(0).voting.limit, 1);

  p.play(0, "vote", slot(p, 0));
  assert.deepEqual(p.g.state.votes, {}, "no voting for your own answer");

  p.play(1, "vote", slot(p, 0));
  assert.deepEqual(p.g.state.votes, { p1: [0] });
  assert.equal(p.view(1).voting.left, 0);
  // Tapping your pick takes it back; tapping another one moves the vote.
  p.play(1, "vote", slot(p, 0));
  assert.deepEqual(p.g.state.votes, {});
  p.play(1, "vote", slot(p, 0));
  p.play(1, "vote", slot(p, 2));
  assert.deepEqual(p.g.state.votes, { p1: [2] });
  assert.equal(mine(1, 2).picked, true);
  assert.equal(p.hostView().votesIn, 1);

  p.play(0, "vote", slot(p, 1));
  p.play(2, "vote", slot(p, 0));
  p.play(3, "vote", slot(p, 0));
  assert.equal(p.g.state.phase, "vote");
  p.play(4, "vote", slot(p, 1));
  // Everyone has used their vote: tallied without waiting for the clock. A tie scores for both.
  assert.equal(p.g.state.phase, "result");
  assert.deepEqual([...p.g.state.winners].sort(), [0, 1]);
  assert.deepEqual(p.g.state.scores, [1, 1, 0]);
  assert.deepEqual(p.view(0).result.mine, { text: "Zero", by: "Player 0", votes: 2, eligible: 5 });
  assert.equal(p.view(1).result.won, true);
});

test("final vote with four crews: two votes each, on two different answers, and both count", () => {
  const p = party(4);
  p.host("configure", { teams: 4 });
  seat(p, [0, 1, 2, 3]);
  p.host("start");
  for (const who of [0, 1, 2, 3]) p.play(who, "answer", `Answer ${who}`);
  assert.equal(p.g.state.phase, "vote");
  assert.equal(p.hostView().votesEach, 2);
  assert.deepEqual([p.view(0).voting.limit, p.view(0).voting.left], [2, 2]);

  // Both votes cannot go on one answer: a second tap takes the first back.
  p.play(0, "vote", slot(p, 1));
  p.play(0, "vote", slot(p, 1));
  assert.deepEqual(p.g.state.votes, {});

  p.play(0, "vote", slot(p, 1));
  p.play(0, "vote", slot(p, 2));
  assert.deepEqual(p.g.state.votes.p0, [1, 2]);
  assert.equal(p.view(0).voting.left, 0);
  // A third pick replaces the oldest.
  p.play(0, "vote", slot(p, 3));
  assert.deepEqual(p.g.state.votes.p0, [2, 3]);
  assert.deepEqual(
    [1, 2, 3].map((crew) => p.view(0).voting.options[slot(p, crew)].picked),
    [false, true, true],
  );

  p.play(1, "vote", slot(p, 0));
  // One of two used: not done yet.
  assert.equal(p.hostView().votesIn, 1);
  p.play(1, "vote", slot(p, 2));
  p.play(2, "vote", slot(p, 0));
  p.play(2, "vote", slot(p, 3));
  p.play(3, "vote", slot(p, 0));
  assert.equal(p.g.state.phase, "vote");
  p.play(3, "vote", slot(p, 2));

  assert.equal(p.g.state.phase, "result");
  // Hot Sauce: p1, p2, p3. Lemons: p0, p1, p3. Pickles: p0, p2. Blueberries: nobody.
  assert.deepEqual([...p.g.state.winners].sort(), [0, 2]);
  assert.deepEqual(p.g.state.scores, [1, 0, 1, 0]);
  const byCrew = Object.fromEntries(p.hostView().results.map((r: any) => [r.team, r.voters.length]));
  assert.deepEqual(byCrew, { 0: 3, 1: 0, 2: 3, 3: 2 });
});

test("votes are one each below four crews, and never more than the answers you can pick from", () => {
  const two = party(2);
  seat(two, [0, 1]);
  two.host("start");
  two.play(0, "answer", "A");
  two.play(1, "answer", "B");
  assert.equal(two.hostView().votesEach, 1);
  assert.equal(two.view(0).voting.limit, 1);

  // Four crews, but only two answered: a writer has one answer left to pick, a bystander has two.
  const four = party(4);
  four.host("configure", { teams: 4 });
  seat(four, [0, 1, 2, 3]);
  four.host("start");
  four.play(0, "answer", "A");
  four.play(1, "answer", "B");
  four.host("next");
  assert.equal(four.g.state.phase, "vote");
  assert.equal(four.view(0).voting.limit, 1);
  assert.equal(four.view(2).voting.limit, 2);
  four.play(0, "vote", slot(four, 1));
  four.play(1, "vote", slot(four, 0));
  four.play(2, "vote", slot(four, 0));
  four.play(2, "vote", slot(four, 1));
  four.play(3, "vote", slot(four, 0));
  assert.equal(four.g.state.phase, "vote");
  four.play(3, "vote", slot(four, 1));
  assert.equal(four.g.state.phase, "result");
  assert.deepEqual([...four.g.state.winners].sort(), [0, 1]);
});

test("heckles come from phones that have locked their answer, and are rate limited", () => {
  const p = party(30);
  p.host("configure", { teams: 3 });
  seat(p, Array.from({ length: 30 }, (_, i) => i % 3));
  p.host("start");
  assert.deepEqual(p.view(2).huddle.heckles, []);
  p.play(2, "heckle", "HA!");
  assert.equal(p.sent.length, 0, "still writing: no heckling");

  // Lemons (players 2, 5, 8, ...) lock in and get the buttons.
  for (let who = 2; who < 30; who += 3) p.play(who, "answer", `Lemon ${who}`);
  assert.equal(p.view(2).huddle.heckles.length, 6);
  p.play(2, "heckle", "not a heckle");
  assert.equal(p.sent.length, 0, "made-up heckles are ignored");

  p.play(2, "heckle", "HA!");
  p.play(2, "heckle", "OOF");
  assert.equal(p.sent.length, 1, "one heckle per phone per second");
  assert.deepEqual(p.sent[0], { to: "host", type: "heckle", data: { kind: "HA!", name: "Player 2", team: 2, vip: false } });

  mock.timers.tick(1_000);
  p.play(2, "heckle", "OOF");
  assert.equal(p.sent.length, 2);

  // Ten Lemons heckle in the same instant: the room-wide cap holds.
  mock.timers.tick(1_000);
  const before = p.sent.length;
  for (let who = 2; who < 30; who += 3) p.play(who, "heckle", "BOO");
  assert.equal(p.sent.length - before, HECKLES_PER_SECOND);

  // When writing closes, everyone may heckle; once the final vote opens, nobody may.
  p.fire("write");
  mock.timers.tick(5_000);
  p.play(0, "heckle", "WOW");
  assert.equal(p.sent.length - before, HECKLES_PER_SECOND + 1);
  p.host("next");
  mock.timers.tick(5_000);
  p.play(5, "heckle", "WOW");
  assert.equal(p.sent.length - before, HECKLES_PER_SECOND + 1);
});

test("teammates and the projector see who is typing, until they lock", () => {
  const p = party(5);
  p.host("configure", { teams: 3 });
  seat(p, [0, 0, 0, 1, 2]);
  p.host("start");
  p.play(1, "typing", "typing");
  p.play(2, "typing", "idea");

  assert.deepEqual(p.view(0).huddle.teammates, [
    { name: "Player 1", typing: "typing" },
    { name: "Player 2", typing: "idea" },
  ]);
  // Other crews are not told.
  assert.deepEqual(p.view(3).huddle.teammates, []);
  assert.deepEqual(
    p.hostView().teams[0].members.map((m: any) => m.typing),
    [null, "typing", "idea"],
  );

  p.play(2, "typing", "idle");
  p.leave(1);
  assert.deepEqual(p.g.state.typing, {});

  p.play(2, "typing", "typing");
  p.play(2, "answer", "A sealed answer");
  assert.deepEqual(p.g.state.typing, {}, "locking the answer ends the typing");
  p.play(2, "typing", "typing");
  assert.deepEqual(p.g.state.typing, {}, "nothing to type once the answer is in");
  // A locked teammate drops off the "is typing" list: their answer is shown instead.
  assert.deepEqual(p.view(0).huddle.teammates, []);

  p.play(0, "typing", "typing");
  p.fire("write");
  assert.deepEqual(p.g.state.typing, {}, "writing is closed");
});

test("a big room votes, and the projector lists voters in the order they voted", () => {
  const p = party(60);
  p.host("configure", { teams: 6 });
  seat(p, Array.from({ length: 60 }, (_, i) => i % 6));
  p.host("start");
  // The first member of each crew locks in; nobody else does before the host moves on.
  for (let crew = 0; crew < 6; crew++) p.play(crew, "answer", `Crew ${crew}`);
  p.host("next");
  assert.equal(p.g.state.phase, "vote");
  const view = p.hostView();
  assert.equal(view.ballot.length, 6);
  assert.equal(view.voters, 60);
  assert.equal(view.voterList.length, 60);

  // Six crews means two votes each: a voter is "in" once both are spent.
  p.play(7, "vote", slot(p, 0));
  p.play(8, "vote", slot(p, 0));
  p.play(8, "vote", slot(p, 3));
  p.play(7, "vote", slot(p, 4));
  const after = p.hostView();
  assert.equal(after.votesIn, 2);
  assert.deepEqual(
    after.voterList.slice(0, 3).map((v: any) => [v.name, v.voted]),
    [
      ["Player 7", true],
      ["Player 8", true],
      ["Player 0", false],
    ],
  );
  assert.equal(p.view(3).voting.waiting, 58);
  assert.deepEqual(p.view(3).voting.waitingOn, ["Player 0", "Player 1"]);
});

test("end-of-show awards: biggest zinger, crickets and loudest heckler", () => {
  const p = party(3);
  p.host("configure", { teams: 3, rounds: 2 });
  seat(p, [0, 1, 2]);
  p.host("start");

  // Round 1: Player 2 locks first and heckles while the others write.
  p.play(2, "answer", "Plain");
  p.play(2, "heckle", "HA!");
  mock.timers.tick(1_100);
  p.play(2, "heckle", "OOF");
  mock.timers.tick(1_100);
  p.play(2, "heckle", "WOW");
  p.play(0, "answer", "Gym Sock Sorbet");
  p.play(1, "answer", "Nana's Couch Cushion");
  // Player 0's answer takes two of three votes; nobody picks Player 1's.
  p.play(1, "vote", slot(p, 0));
  p.play(2, "vote", slot(p, 0));
  p.play(0, "vote", slot(p, 2));
  assert.deepEqual(p.g.state.winners, [0]);
  p.host("next");

  // Round 2: answers go up but nobody votes in time. A round with no votes at
  // all earns nobody the crickets award.
  p.play(0, "answer", "Silence");
  p.play(1, "answer", "More silence");
  p.host("next");
  p.host("next");
  assert.deepEqual(p.g.state.winners, []);
  p.host("next");
  assert.equal(p.g.state.phase, "end");

  const { awards } = p.hostView();
  assert.deepEqual(awards.zinger, { text: "Gym Sock Sorbet", by: "Player 0", team: 0, votes: 2, eligible: 3 });
  assert.deepEqual(awards.crickets, { name: "Player 1", team: 1, count: 1 });
  assert.deepEqual(awards.heckler, { name: "Player 2", team: 2, count: 3 });
  assert.equal(p.view(0).end.place, 1);
  assert.equal(p.view(0).end.won, true);

  // Encore starts a clean slate: no awards carried over.
  p.host("start");
  // With no answers each round goes crew stage -> result -> next round.
  for (let i = 0; i < 4; i++) p.host("next");
  assert.equal(p.g.state.phase, "end");
  assert.deepEqual(p.hostView().awards, { zinger: null, crickets: null, heckler: null });
});

test("AI prompts: offered only with a key, written from the theme and level, and not repeated on an encore", async () => {
  const without = party(2);
  assert.equal(without.hostView().aiAvailable, false);
  without.host("configure", { source: "ai" });
  assert.equal(without.g.state.config.source, "pack", "no key, no AI");

  const requests: PromptRequest[] = [];
  let batch = 0;
  const p = party(2, {
    aiAvailable: true,
    generate: async (request) => {
      requests.push(request);
      batch += 1;
      return Array.from({ length: request.count }, (_, i) => `Batch ${batch} prompt ${i + 1}`);
    },
  });
  assert.equal(p.hostView().aiAvailable, true);
  assert.deepEqual(p.hostView().aiLevels, ["Unc", "Clean", "Cheeky", "Spicy", "NSFW"]);
  assert.equal(p.g.state.config.aiLevel, 1);

  p.host("configure", { source: "ai", aiTheme: `  camping   trip ${"x".repeat(300)}`, aiLevel: 4, rounds: 3 });
  p.host("configure", { aiLevel: 5 });
  p.host("configure", { aiLevel: 1.5 });
  assert.equal(p.g.state.config.aiLevel, 4);
  assert.equal(p.g.state.config.aiTheme.length, 200);
  assert.ok(p.g.state.config.aiTheme.startsWith("camping trip x"));
  p.host("configure", { aiTheme: "camping trip" });
  seat(p, [0, 1]);

  p.host("start");
  assert.equal(p.g.state.phase, "generating");
  assert.equal(p.view(0).phase, "generating");
  assert.equal(p.hostView().prompt, null);
  await settle();
  assert.equal(p.g.state.phase, "team");
  assert.equal(p.syncs(), 1, "the screens are told when the prompts arrive");
  assert.deepEqual(requests[0], { theme: "camping trip", level: 4, count: 3, avoid: [] });
  assert.match(p.hostView().prompt, /^Batch 1 prompt [123]$/);
  assert.equal(p.hostView().total, 3);

  for (let i = 0; i < 6; i++) p.host("next");
  assert.equal(p.g.state.phase, "end");
  // Encore: the same settings, and the prompts just played are passed along to avoid.
  p.host("start");
  await settle();
  assert.equal(p.g.state.phase, "team");
  assert.deepEqual(requests[1], {
    theme: "camping trip",
    level: 4,
    count: 3,
    avoid: ["Batch 1 prompt 1", "Batch 1 prompt 2", "Batch 1 prompt 3"],
  });
  assert.match(p.hostView().prompt, /^Batch 2/);
});

test("AI prompts: a failure returns to the lobby with the reason, and a cancelled request is ignored", async () => {
  let answer!: { resolve: (prompts: string[]) => void; reject: (error: Error) => void };
  const p = party(2, {
    aiAvailable: true,
    generate: () => new Promise<string[]>((resolve, reject) => (answer = { resolve, reject })),
  });
  seat(p, [0, 1]);
  p.host("configure", { source: "ai" });

  p.host("start");
  assert.equal(p.g.state.phase, "generating");
  // Nothing else can start while the writer is busy.
  p.host("start");
  p.host("next");
  assert.equal(p.g.state.phase, "generating");
  await settle();
  answer.reject(new Error("The AI writer's API key was refused. Check ANTHROPIC_API_KEY."));
  await settle();
  assert.equal(p.g.state.phase, "lobby");
  assert.match(p.hostView().aiError, /API key was refused/);
  assert.equal(p.syncs(), 1);

  // Changing a setting clears the complaint.
  p.host("configure", { aiLevel: 2 });
  assert.equal(p.hostView().aiError, null);

  // The host cancels, then starts a pack game; the late answer must not replace it.
  p.host("start");
  await settle();
  const late = answer;
  p.host("lobby");
  assert.equal(p.g.state.phase, "lobby");
  p.host("configure", { source: "pack" });
  p.host("start");
  assert.equal(p.g.state.phase, "team");
  const prompt = p.hostView().prompt;
  late.resolve(["Late 1", "Late 2", "Late 3", "Late 4", "Late 5"]);
  await settle();
  assert.equal(p.hostView().prompt, prompt);
  assert.match(prompt, /^Prompt \d+$/);
  assert.equal(p.syncs(), 1);
});

test("AI enhance: a share of a pack's rounds is written by the AI in the pack's style, and shuffled in with its own", async () => {
  assert.deepEqual([0, 10, 50, 90, 100].map((mix) => aiRounds(5, mix)), [0, 1, 3, 5, 5]);
  assert.deepEqual([10, 30, 50].map((mix) => aiRounds(10, mix)), [1, 3, 5]);

  const without = party(2);
  without.host("configure", { aiMix: 50 });
  assert.equal(without.g.state.config.aiMix, 0, "no key, no enhancing");

  const requests: PromptRequest[] = [];
  const p = party(2, {
    aiAvailable: true,
    generate: async (request) => {
      requests.push(request);
      return Array.from({ length: request.count }, (_, i) => `New roast ${requests.length}.${i + 1}`);
    },
  });
  assert.equal(p.g.state.config.aiMix, 0);
  assert.equal(p.hostView().aiRounds, 0);
  for (const bad of [-10, 101, "50", NaN]) p.host("configure", { aiMix: bad });
  assert.equal(p.g.state.config.aiMix, 0);

  p.host("configure", { pack: "party", aiMix: 40, aiLevel: 2, aiTheme: "ignored here" });
  assert.equal(p.hostView().aiRounds, 2);
  // The pack keeps its look and its seat: it is still the pack's show.
  assert.equal(p.hostView().theme, "raju60");
  assert.deepEqual(p.hostView().vip, { title: "Birthday Boy", votes: 3, holder: null });
  assert.equal(p.hostView().usesAi, false);
  seat(p, [0, 1]);

  p.host("start");
  assert.equal(p.g.state.phase, "generating");
  await settle();
  assert.equal(p.g.state.phase, "team");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].count, 2);
  assert.equal(requests[0].level, 2);
  assert.equal(requests[0].theme, "", "the pack is the theme");
  assert.equal(requests[0].pack?.name, "Raju's 60th");
  assert.deepEqual(requests[0].pack?.examples, PACKS[1].prompts);
  const show = p.g.state.prompts;
  assert.equal(show.length, 5);
  assert.equal(show.filter((prompt) => /^New roast 1\.[12]$/.test(prompt)).length, 2);
  assert.equal(show.filter((prompt) => /^Roast \d+$/.test(prompt)).length, 3);
  assert.equal(new Set(show).size, 5);

  // Encore: everything just played, the AI's and the pack's, is passed along to avoid.
  for (let i = 0; i < 10; i++) p.host("next");
  assert.equal(p.g.state.phase, "end");
  p.host("start");
  await settle();
  assert.deepEqual([...requests[1].avoid].sort(), [...show].sort());
  assert.equal(p.g.state.prompts.filter((prompt) => show.includes(prompt)).length, 0);

  // All AI is still the pack's show; none is a plain pack show, with no waiting.
  for (let i = 0; i < 10; i++) p.host("next");
  p.host("lobby");
  p.host("configure", { aiMix: 100 });
  p.host("start");
  await settle();
  assert.equal(requests[2].count, 5);
  assert.ok(p.g.state.prompts.every((prompt) => /^New roast 3\./.test(prompt)));
  assert.equal(p.hostView().theme, "raju60");
  for (let i = 0; i < 10; i++) p.host("next");
  p.host("lobby");
  p.host("configure", { aiMix: 0 });
  p.host("start");
  assert.equal(p.g.state.phase, "team");
  assert.equal(requests.length, 3);

  // With AI prompts as the source there is no pack to enhance.
  const q = party(2, { aiAvailable: true, generate: async (request) => Array.from({ length: request.count }, (_, i) => `P${i}`) });
  q.host("configure", { aiMix: 50, source: "ai" });
  assert.equal(q.hostView().aiRounds, 0);
});

test("AI enhance: a failure returns to the lobby with the reason", async () => {
  const p = party(2, { aiAvailable: true, generate: async () => Promise.reject(new Error("Could not reach the AI writer.")) });
  seat(p, [0, 1]);
  p.host("configure", { aiMix: 50 });
  p.host("start");
  await settle();
  assert.equal(p.g.state.phase, "lobby");
  assert.match(p.hostView().aiError, /Could not reach/);
});

// ---------- the guest of honour ----------

/** A show on the pack with a guest-of-honour seat (votes ×3). */
function gala(count: number, teams = 2) {
  const p = party(count);
  p.host("configure", { pack: "party", teams });
  return p;
}

/** Everyone on a crew writes "Answer N"; the crew stage then ends, with the earliest lock published. */
function writeAll(p: Party) {
  p.players.forEach((player, who) => {
    if (p.g.state.teamOf[player.id] !== undefined) p.play(who, "answer", `Answer ${who}`);
  });
  if (p.g.state.phase === "team") p.host("next");
}

test("a pack file may offer a guest-of-honour seat", () => {
  assert.equal(parsePack("a", { prompts: ["x"] }).vip, null);
  assert.deepEqual(parsePack("a", { vip: true, prompts: ["x"] }).vip, { title: "Guest of Honour", votes: 3 });
  assert.deepEqual(parsePack("a", { vip: { title: " Birthday Girl ", votes: 5 }, prompts: ["x"] }).vip, { title: "Birthday Girl", votes: 5 });
  // Nonsense falls back to the defaults rather than breaking the pack.
  assert.deepEqual(parsePack("a", { vip: { title: 7, votes: 0 }, prompts: ["x"] }).vip, { title: "Guest of Honour", votes: 3 });
  assert.equal(parsePack("a", { vip: "yes", prompts: ["x"] }).vip, null);
});

test("guest of honour: one seat, only on a pack that offers it, and the host can empty it", () => {
  const p = party(3, { aiAvailable: true });
  assert.equal(p.view(0).vip, null);
  p.play(0, "vip", true);
  assert.equal(p.g.state.vipId, null, "no seat on a plain pack");

  p.host("configure", { pack: "party" });
  assert.deepEqual(p.view(0).vip, { title: "Birthday Boy", votes: 3, mine: false, takenBy: null, canClaim: true, canLeave: false });
  assert.deepEqual(p.hostView().vip, { title: "Birthday Boy", votes: 3, holder: null });
  p.play(0, "vip", true);
  p.play(1, "vip", true);
  assert.equal(p.g.state.vipId, "p0", "first come, first served");
  assert.deepEqual([p.view(0).vip.mine, p.view(0).vip.canLeave, p.view(0).voteWeight], [true, true, 3]);
  assert.deepEqual([p.view(1).vip.takenBy, p.view(1).vip.canClaim, p.view(1).voteWeight], ["Player 0", false, 1]);
  assert.deepEqual(p.hostView().vip.holder, { name: "Player 0", team: null, connected: true });

  // Watching, they are not "still choosing"; on a crew, they are marked in it.
  assert.equal(p.view(0).watching, true);
  assert.deepEqual(p.hostView().unassigned, ["Player 1", "Player 2"]);
  p.play(0, "join", 1);
  assert.equal(p.view(0).watching, false);
  assert.deepEqual(p.hostView().teams[1].members.map((m: any) => m.vip), [true]);
  assert.equal(p.hostView().vip.holder.team, 1);
  p.play(1, "watch");
  assert.equal(p.view(1).team, null);
  p.play(1, "join", 0);
  p.play(1, "watch");
  assert.equal(p.view(1).team, 0, "only the guest of honour can watch");
  p.play(0, "watch");
  assert.equal(p.view(0).watching, true);

  // Another pack, or AI prompts, has no seat; coming back finds the same person in it.
  p.host("configure", { source: "ai" });
  assert.deepEqual([p.view(0).vip, p.view(0).watching, p.view(0).voteWeight], [null, false, 1]);
  assert.deepEqual(p.hostView().unassigned, ["Player 0", "Player 2"]);
  p.host("configure", { source: "pack" });
  assert.equal(p.view(0).vip.mine, true);

  // Giving the seat back, and the host emptying it.
  p.play(1, "vip", false);
  assert.equal(p.g.state.vipId, "p0", "only the holder can give it back");
  p.play(0, "vip", false);
  assert.equal(p.g.state.vipId, null);
  p.play(1, "vip", true);
  assert.equal(p.view(1).team, 0, "taking the seat keeps your crew");
  p.host("unseat");
  assert.deepEqual([p.g.state.vipId, p.view(1).team], [null, 0]);
});

test("guest of honour: shuffle, balance and the curtain leave them where they chose", () => {
  const p = gala(7);
  p.play(0, "vip", true);
  seat(p, [-1, 0, 0, 0, 0, 0]);
  p.host("balance");
  assert.equal(p.view(0).watching, true, "balance does not draft a watching guest");
  assert.deepEqual(sizes(p), [3, 3]);
  p.host("shuffle");
  assert.equal(p.view(0).watching, true);
  assert.deepEqual(sizes(p), [3, 3]);

  // On a crew, they are the one person balance and shuffle never move.
  p.play(0, "join", 1);
  for (let who = 1; who < 6; who++) p.play(who, "join", 1);
  p.play(6, "join", 0);
  p.host("balance");
  assert.equal(p.view(0).team, 1);
  assert.deepEqual(sizes(p), [3, 4]);
  p.host("shuffle");
  assert.equal(p.view(0).team, 1);

  p.play(0, "watch");
  p.host("start");
  assert.equal(p.g.state.phase, "team");
  assert.equal(p.view(0).watching, true, "not placed as a straggler");
});

test("guest of honour, watching: heckles from the start, votes on every answer, and each vote counts three", () => {
  const p = gala(5, 3);
  p.play(0, "vip", true);
  seat(p, [-1, 0, 0, 1, 2]);
  p.host("start");

  // Nothing to write, so the heckles are there straight away; nobody waits on them.
  assert.equal(p.view(0).huddle, null);
  assert.equal(p.view(0).spectate.heckles.length, 6);
  assert.equal(p.view(1).spectate, null);
  p.play(0, "heckle", "HA!");
  assert.deepEqual(p.sent.at(-1)!.data, { kind: "HA!", name: "Player 0", team: null, vip: true });
  p.play(0, "answer", "Not mine to write");
  assert.deepEqual(p.g.state.locked, {});
  assert.equal(p.hostView().writers, 4);
  writeAll(p);
  assert.equal(p.g.state.phase, "vote");

  // They are first on the projector's list of judges before voting and after.
  assert.equal(p.hostView().voters, 5);
  assert.deepEqual(p.hostView().voterList[0], { name: "Player 0", team: null, voted: false, vip: true });
  assert.deepEqual(p.view(0).voting.options.map((o: any) => [o.allowed, o.own, o.yours]), [[true, false, false], [true, false, false], [true, false, false]]);
  p.play(1, "vote", slot(p, 1));
  p.play(2, "vote", slot(p, 1));
  p.play(0, "vote", slot(p, 2));
  assert.deepEqual(p.hostView().voterList.map((v: any) => [v.name, v.voted]).slice(0, 3), [["Player 0", true], ["Player 1", true], ["Player 2", true]]);
  p.play(3, "vote", slot(p, 0));
  p.play(4, "vote", slot(p, 0));
  assert.equal(p.g.state.phase, "result");

  // Crew 0 and crew 1 drew two voters each; the guest's single vote for crew 2 beats both.
  assert.deepEqual(p.g.state.winners, [2]);
  assert.deepEqual(p.g.state.scores, [0, 0, 1]);
  const results = p.hostView().results;
  assert.deepEqual(results.map((r: any) => [r.team, r.votes, r.voters.length]), [[2, 3, 1], [0, 2, 2], [1, 2, 2]]);
  assert.deepEqual(results[0].voters, [{ name: "Player 0", team: null, vip: true }]);
  // Five judges, seven votes to be had.
  assert.equal(p.hostView().eligible, 7);
  assert.deepEqual(p.view(4).result.mine, { text: "Answer 4", by: "Player 4", votes: 3, eligible: 7 });
  assert.deepEqual([p.view(0).result.won, p.view(0).result.mine, p.view(0).result.place], [false, null, null]);

  while (p.g.state.phase !== "end") p.host("next");
  assert.deepEqual(p.view(0).end.champions, ["Ladoos"]);
  assert.equal(p.view(0).end.place, null);
  assert.equal(p.hostView().awards.zinger.votes, 3);
});

test("guest of honour, on a crew: writes and backs a teammate at face value, and never votes for their own answer", () => {
  const p = gala(4);
  seat(p, [0, 0, 1, 1]);
  p.play(0, "vip", true);
  p.host("start");
  assert.equal(p.view(0).spectate, null);
  p.play(0, "answer", "From the guest");
  p.play(1, "answer", "From a teammate");
  p.play(2, "answer", "Two");
  p.play(3, "answer", "Three");
  // In the crew stage the guest's vote is one vote like anybody's.
  p.play(0, "teamVote", "p1");
  assert.equal(p.view(1).huddle.answers.find((a: any) => a.id === "p1").votes, 1);
  p.play(1, "teamVote", "p0");
  p.play(2, "teamVote", "p3");
  p.play(3, "teamVote", "p2");
  assert.equal(p.g.state.phase, "vote");
  assert.equal(p.g.state.answers[0].byId, "p0");

  p.play(0, "vote", slot(p, 0));
  assert.deepEqual(p.g.state.votes, {}, "not for the answer they wrote");
  p.play(0, "vote", slot(p, 1));
  p.play(1, "vote", slot(p, 0));
  p.play(2, "vote", slot(p, 0));
  p.play(3, "vote", slot(p, 0));
  // Three voters for crew 0, and the guest's three for crew 1: a tie.
  assert.deepEqual([...p.g.state.winners].sort(), [0, 1]);
  assert.equal(p.hostView().results.find((r: any) => r.team === 1).voters[0].vip, true);
});

test("guest of honour: with two votes each, both count three; mid-show only a latecomer can take the seat", () => {
  const p = gala(5, 4);
  seat(p, [0, 1, 2, 3]);
  // Player 4 is still parking the car when the curtain goes up.
  p.players[4].connected = false;
  p.host("start");
  p.players[4].connected = true;
  p.play(0, "vip", true);
  assert.equal(p.g.state.vipId, null, "someone already on a crew cannot take the seat once the show is running");
  assert.equal(p.view(0).vip.canClaim, false);
  assert.equal(p.view(4).vip.canClaim, true);
  p.play(4, "vip", true);
  assert.equal(p.view(4).watching, true);
  p.play(4, "vip", false);
  assert.equal(p.g.state.vipId, "p4", "and there is no giving it back mid-show");
  assert.equal(p.view(4).vip.canLeave, false);

  writeAll(p);
  assert.equal(p.view(4).voting.limit, 2);
  p.play(4, "vote", slot(p, 0));
  p.play(4, "vote", slot(p, 1));
  p.play(0, "vote", slot(p, 2));
  p.play(1, "vote", slot(p, 2));
  p.host("next");
  assert.deepEqual([...p.g.state.winners].sort(), [0, 1]);
  assert.deepEqual([0, 1, 2, 3].map((team) => p.hostView().results.find((r: any) => r.team === team).votes), [3, 3, 2, 0]);

  // A guest who goes home mid-show is not waited for.
  p.host("next");
  p.leave(4);
  writeAll(p);
  assert.equal(p.hostView().voters, 4);
  assert.equal(p.hostView().voterList.some((v: any) => v.vip), false);
});
