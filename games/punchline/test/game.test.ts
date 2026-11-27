// Drives Punchline's rules directly, with a stand-in for the SDK's `g`, so
// crews, heckles, typing, balancing and awards are checked without a browser.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { Game, Player } from "@arcade/sdk";
import { CREWS, HECKLES_PER_SECOND, createDefinition, type Pack, type State } from "../game.ts";

const PACKS: Pack[] = [
  { id: "test", name: "Test", description: "", prompts: Array.from({ length: 20 }, (_, i) => `Prompt ${i + 1}`) },
];

interface Seat extends Player {
  connected: boolean;
}

function party(count: number) {
  const def = createDefinition(PACKS);
  const players: Seat[] = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, connected: true }));
  const timers = new Map<string, { at: number; fn: () => void }>();
  const sent: { to: unknown; type: string; data: any }[] = [];
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
    sync: () => {},
    end: () => {},
  };
  return {
    g,
    players,
    sent,
    host: (type: string, data?: unknown) => def.onHost![type](g, data),
    play: (who: number, type: string, data?: unknown) => def.onPlayer![type](g, players[who], data),
    leave: (who: number) => {
      players[who].connected = false;
      def.onLeave!(g, players[who]);
    },
    hostView: () => def.hostView(g) as any,
    view: (who: number) => def.playerView(g, players[who]) as any,
  };
}

/** Players 0..n-1 join crews round-robin. */
function seat(p: ReturnType<typeof party>, crews: number[]) {
  crews.forEach((crew, who) => p.play(who, "join", crew));
}

const sizes = (p: ReturnType<typeof party>) => p.hostView().teams.map((team: any) => team.members.length);

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
afterEach(() => mock.timers.reset());

test("up to eight crews, named, and no more", () => {
  const p = party(2);
  p.host("configure", { teams: 8 });
  assert.deepEqual(
    p.hostView().teams.map((team: any) => team.name),
    CREWS,
  );
  assert.equal(CREWS.length, 8);
  p.host("configure", { teams: 9 });
  assert.equal(p.g.state.config.teams, 8);
  p.play(0, "join", 7);
  assert.equal(p.view(0).teamName, "Marshmallows");
  // Dropping to fewer crews sends their members back to the picker.
  p.host("configure", { teams: 4 });
  assert.equal(p.view(0).team, null);
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
  assert.equal(p.g.state.phase, "write");
  // Blueberries had one, so the first straggler evens it up and the second goes to Hot Sauce.
  assert.equal(p.g.state.teamOf.p3, 1);
  assert.equal(p.g.state.teamOf.p4, 0);
});

test("heckles come only from crews not writing, and are rate limited", () => {
  const p = party(30);
  p.host("configure", { teams: 3 });
  seat(p, Array.from({ length: 30 }, (_, i) => i % 3));
  p.host("start");
  // Hot Sauce and Blueberries write; Lemons (players 2, 5, 8, ...) heckle.
  assert.deepEqual(p.g.state.answering, [0, 1]);
  assert.deepEqual(p.view(2).writing.heckles.length, 6);
  assert.deepEqual(p.view(0).writing.heckles, []);

  p.play(0, "heckle", "HA!");
  p.play(2, "heckle", "not a heckle");
  assert.equal(p.sent.length, 0, "writers and made-up heckles are ignored");

  p.play(2, "heckle", "HA!");
  p.play(2, "heckle", "OOF");
  assert.equal(p.sent.length, 1, "one heckle per phone per second");
  assert.deepEqual(p.sent[0], { to: "host", type: "heckle", data: { kind: "HA!", name: "Player 2", team: 2 } });

  mock.timers.tick(1_000);
  p.play(2, "heckle", "OOF");
  assert.equal(p.sent.length, 2);

  // Ten Lemons heckle in the same instant: the room-wide cap holds.
  mock.timers.tick(1_000);
  const before = p.sent.length;
  for (let who = 2; who < 30; who += 3) p.play(who, "heckle", "BOO");
  assert.equal(p.sent.length - before, HECKLES_PER_SECOND);

  // Once voting opens, heckling stops.
  p.host("next");
  mock.timers.tick(5_000);
  p.play(5, "heckle", "WOW");
  assert.equal(p.sent.length - before, HECKLES_PER_SECOND);
});

test("teammates and the projector see who is typing", () => {
  const p = party(5);
  p.host("configure", { teams: 3 });
  seat(p, [0, 0, 0, 1, 2]);
  p.host("start");
  p.play(1, "typing", "typing");
  p.play(2, "typing", "idea");
  p.play(4, "typing", "typing"); // Lemons are not writing: ignored

  assert.deepEqual(p.view(0).writing.teammates, [
    { name: "Player 1", typing: "typing" },
    { name: "Player 2", typing: "idea" },
  ]);
  assert.deepEqual(
    p.hostView().teams[0].members.map((m: any) => m.typing),
    [null, "typing", "idea"],
  );
  assert.deepEqual(p.g.state.typing, { p1: "typing", p2: "idea" });

  p.play(2, "typing", "idle");
  p.leave(1);
  assert.deepEqual(p.g.state.typing, {});

  p.play(2, "typing", "typing");
  p.play(0, "answer", "A sealed answer");
  assert.deepEqual(p.g.state.typing, {}, "sending the answer clears the crew");
  assert.equal(p.hostView().teams[0].sentBy, "Player 0");
  p.play(2, "typing", "typing");
  assert.deepEqual(p.g.state.typing, {}, "nothing to type once the answer is in");
});

test("a big room votes, and the projector lists voters in the order they voted", () => {
  const p = party(60);
  p.host("configure", { teams: 6, answering: 2 });
  seat(p, Array.from({ length: 60 }, (_, i) => i % 6));
  p.host("start");
  p.play(0, "answer", "Zero");
  p.play(1, "answer", "One");
  assert.equal(p.g.state.phase, "vote");
  const view = p.hostView();
  assert.equal(view.voters, 40, "four neutral crews of ten vote");
  assert.equal(view.voterList.length, 40);

  const ballot = p.g.state.ballot;
  p.play(5, "vote", ballot.indexOf(0));
  p.play(2, "vote", ballot.indexOf(1));
  const after = p.hostView();
  assert.equal(after.votesIn, 2);
  assert.deepEqual(
    after.voterList.slice(0, 3).map((v: any) => [v.name, v.voted]),
    [
      ["Player 5", true],
      ["Player 2", true],
      ["Player 3", false],
    ],
  );
  assert.equal(p.view(3).voting.waiting, 38);
  assert.deepEqual(p.view(3).voting.waitingOn, ["Player 3", "Player 4"]);
});

test("own-crew votes stay off limits and ties score for both", () => {
  const p = party(4);
  p.host("configure", { teams: 4, answering: 2 });
  seat(p, [0, 1, 2, 3]);
  p.host("start");
  p.play(0, "answer", "Zero");
  p.play(1, "answer", "One");
  const ballot = p.g.state.ballot;
  // Only two answers are up: the crews that wrote them sit the vote out.
  p.play(0, "vote", ballot.indexOf(1));
  assert.deepEqual(p.g.state.votes, {});
  p.play(2, "vote", ballot.indexOf(0));
  p.play(3, "vote", ballot.indexOf(1));
  assert.equal(p.g.state.phase, "result");
  assert.deepEqual([...p.g.state.winners].sort(), [0, 1]);
  assert.deepEqual(p.g.state.scores, [1, 1, 0, 0]);
  assert.equal(p.view(0).result.mine.votes, 1);
  assert.equal(p.view(0).result.mine.eligible, 2);
});

test("end-of-show awards: biggest zinger, crickets and loudest heckler", () => {
  const p = party(6);
  p.host("configure", { teams: 3, rounds: 3 });
  seat(p, [0, 0, 1, 1, 2, 2]);
  p.host("start");

  // Round 1: Hot Sauce vs Blueberries, Lemons judge. Player 0's answer sweeps.
  p.play(4, "heckle", "HA!");
  mock.timers.tick(1_100);
  p.play(4, "heckle", "OOF");
  mock.timers.tick(1_100);
  p.play(4, "heckle", "WOW");
  p.play(0, "answer", "Gym Sock Sorbet");
  p.play(2, "answer", "Nana's Couch Cushion");
  let ballot = p.g.state.ballot;
  p.play(4, "vote", ballot.indexOf(0));
  p.play(5, "vote", ballot.indexOf(0));
  assert.deepEqual(p.g.state.winners, [0]);
  p.host("next");

  // Round 2: Lemons vs Hot Sauce, Blueberries judge. Player 2 judges; nobody likes Player 4's.
  assert.deepEqual(p.g.state.answering, [0, 2]);
  p.play(1, "answer", "Mint Mayo");
  p.play(4, "answer", "Plain");
  ballot = p.g.state.ballot;
  p.play(2, "vote", ballot.indexOf(0));
  p.play(3, "vote", ballot.indexOf(0));
  p.host("next");

  // Round 3: Blueberries vs Lemons, nobody votes in time. A round with no votes
  // at all earns nobody the crickets award.
  p.play(3, "answer", "Silence");
  p.play(5, "answer", "More silence");
  p.host("next");
  p.host("next");
  assert.equal(p.g.state.phase, "end");

  const { awards } = p.hostView();
  assert.deepEqual(awards.zinger, { text: "Gym Sock Sorbet", by: "Player 0", team: 0, votes: 2, eligible: 2 });
  assert.deepEqual(awards.crickets, { name: "Player 2", team: 1, count: 1 });
  assert.deepEqual(awards.heckler, { name: "Player 4", team: 2, count: 3 });
  assert.equal(p.view(0).end.place, 1);
  assert.equal(p.view(0).end.won, true);

  // Encore starts a clean slate: no awards carried over.
  p.host("start");
  // With no answers each round goes write -> result -> next round.
  for (let i = 0; i < 6; i++) p.host("next");
  assert.equal(p.g.state.phase, "end");
  assert.deepEqual(p.hostView().awards, { zinger: null, crickets: null, heckler: null });
});
