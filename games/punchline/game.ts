// Punchline: crews write the funniest answer to a prompt, everyone votes, and
// the answer with the most votes scores for its crew.
//
// The host chooses how many crews there are (2 to 8), how many of them answer
// each round (2, 3, ... or all), how many rounds to play, and which question
// pack to use. Packs are the JSON files in ./questions: drop another one in and
// it shows up in the lobby the next time the game is opened.
//
// This file holds the rules and views; server.ts hands them to the SDK. They
// are split so the tests can drive the rules without starting a server.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Game, GameDefinition, Player } from "@arcade/sdk";

// ---------- question packs ----------

export interface Pack {
  id: string;
  name: string;
  description: string;
  prompts: string[];
}

const PACK_DIR = path.join(import.meta.dirname, "questions");
const MAX_PROMPT = 200;

/** One pack file: { "name": "...", "description": "...", "prompts": ["...", { "text": "..." }] } */
export function parsePack(id: string, raw: unknown): Pack {
  if (!raw || typeof raw !== "object") throw new Error("must be a JSON object");
  const file = raw as Record<string, unknown>;
  if (!Array.isArray(file.prompts)) throw new Error(`"prompts" must be a list`);
  const prompts: string[] = [];
  for (const entry of file.prompts) {
    const text = typeof entry === "string" ? entry : (entry as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_PROMPT) {
      throw new Error(`every prompt must be text of at most ${MAX_PROMPT} characters`);
    }
    if (!prompts.includes(text.trim())) prompts.push(text.trim());
  }
  if (prompts.length === 0) throw new Error(`"prompts" is empty`);
  return {
    id,
    name: typeof file.name === "string" && file.name.trim() ? file.name.trim().slice(0, 40) : id,
    description: typeof file.description === "string" ? file.description.trim().slice(0, 120) : "",
    prompts,
  };
}

function loadPacks(): Pack[] {
  const packs: Pack[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(PACK_DIR).filter((name) => name.endsWith(".json")).sort();
  } catch {
    console.error(`[punchline] no questions folder at ${PACK_DIR}`);
  }
  for (const name of files) {
    try {
      packs.push(parsePack(name.slice(0, -".json".length), JSON.parse(readFileSync(path.join(PACK_DIR, name), "utf8"))));
    } catch (error) {
      // A broken pack must not hide the good ones.
      console.error(`[punchline] skipped questions/${name}: ${(error as Error).message}`);
    }
  }
  return packs;
}

// ---------- rules ----------

/** Crew names, in the order crews are added. The clients pair each with a mascot and colour. */
export const CREWS = ["Hot Sauce", "Blueberries", "Lemons", "Pickles", "Grapes", "Tangerines", "Mints", "Marshmallows"];
export const MIN_CREWS = 2;
export const MAX_CREWS = CREWS.length;
const MAX_ROUNDS = 20;
export const MAX_ANSWER = 100;
export const WRITE_MS = 90_000;
export const VOTE_MS = 45_000;

/** What a phone that is not writing this round can shout at the stage. */
export const HECKLES = ["HA!", "OOF", "WOW", "*clap*", "BOO", "zzz"];
/** One heckle per phone this often, at most. */
export const HECKLE_GAP_MS = 1_000;
/** And at most this many reach the projector in any one second, however big the room. */
export const HECKLES_PER_SECOND = 8;

interface Config {
  teams: number;
  /** How many crews write an answer each round. */
  answering: number | "all";
  rounds: number;
  pack: string;
}

/** What a writer's phone last said about them: typing now, or paused with a draft. */
type Typing = "typing" | "idea";

/** One played round, kept for the end-of-show awards. */
interface RoundRecord {
  /** Players who could vote when the round was tallied. */
  eligible: number;
  /** False when a lone answer scored unopposed: nobody had a choice to make. */
  contested: boolean;
  answers: { team: number; text: string; by: string; byId: string; votes: number }[];
}

export interface State {
  phase: "lobby" | "write" | "vote" | "result" | "end";
  config: Config;
  /** Player id -> crew index. Players not in here have not picked a crew yet. */
  teamOf: Record<string, number>;
  scores: number[];
  prompts: string[];
  round: number;
  /** Prompts already played since the game was opened, so "play again" brings new ones. */
  used: string[];
  /** Next crew in the rotation of who answers. */
  cursor: number;
  /** Crews writing this round. */
  answering: number[];
  /** Crew index -> its answer. */
  answers: Record<number, { text: string; by: string; byId: string }>;
  /** Crews with an answer, in the shuffled order shown on the ballot. */
  ballot: number[];
  /**
   * True when nobody has two answers to choose from besides their own (two
   * crews, both answering). Everyone then votes on everything, own crew included.
   */
  openVote: boolean;
  /** Player id -> crew voted for, in the order the votes came in. */
  votes: Record<string, number>;
  winners: number[];
  /** Voters who could vote this round, counted when it was tallied. */
  eligible: number;
  /** Writers on an answering crew who are typing or have a draft. */
  typing: Record<string, Typing>;
  /** Player id -> when they last heckled (epoch ms). */
  heckledAt: Record<string, number>;
  /** When the most recent heckles reached the projector, for the room-wide limit. */
  heckleWindow: number[];
  /** Player id -> heckles sent this show. */
  heckles: Record<string, number>;
  history: RoundRecord[];
}

export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const teamIndexes = (g: Game<State>): number[] => Array.from({ length: g.state.config.teams }, (_, i) => i);
const members = (g: Game<State>, team: number): Player[] => g.players.filter((p) => g.state.teamOf[p.id] === team);
const answeringCount = (config: Config): number =>
  config.answering === "all" ? config.teams : Math.min(config.answering, config.teams);

/** Why the game cannot start yet, or null when it can. */
function startProblem(g: Game<State>, packs: Pack[]): string | null {
  if (!packs.some((entry) => entry.id === g.state.config.pack)) return "No question packs found.";
  const empty = teamIndexes(g).filter((team) => members(g, team).length === 0);
  if (empty.length > 0) return `Waiting for players on ${empty.map((team) => CREWS[team]).join(", ")}.`;
  return null;
}

/** Ballot entries a crew's members could pick from if own answers are off limits. */
const othersOnBallot = (g: Game<State>, team: number): number[] => g.state.ballot.filter((entry) => entry !== team);

/** The crews this player may vote for; empty when they sit this vote out. */
function choices(g: Game<State>, player: Player): number[] {
  const team = g.state.teamOf[player.id];
  if (g.state.phase !== "vote" || team === undefined) return [];
  if (g.state.openVote) return g.state.ballot;
  // With a single other answer there is nothing to choose: that crew's members sit out.
  const others = othersOnBallot(g, team);
  return others.length >= 2 ? others : [];
}

/** Connected players who may vote this round. */
const voters = (g: Game<State>): Player[] => g.players.filter((p) => p.connected && choices(g, p).length > 0);

/**
 * Crew sizes counting connected players only: a phone that went home should
 * not make its crew look full.
 */
function liveSizes(g: Game<State>): number[] {
  const sizes = teamIndexes(g).map(() => 0);
  for (const p of g.players) {
    const team = g.state.teamOf[p.id];
    if (p.connected && team !== undefined) sizes[team] += 1;
  }
  return sizes;
}

const smallest = (sizes: number[]): number => sizes.indexOf(Math.min(...sizes));

/** Put connected players who have not picked a crew on the smallest crews. */
function placeStragglers(g: Game<State>): void {
  const sizes = liveSizes(g);
  for (const p of g.players) {
    if (!p.connected || p.id in g.state.teamOf) continue;
    const team = smallest(sizes);
    g.state.teamOf[p.id] = team;
    sizes[team] += 1;
  }
}

/**
 * Even the crews out with as few moves as possible: stragglers first go to the
 * smallest crews, then the latest arrivals on the biggest crew move to the
 * smallest until no two crews differ by more than one.
 */
export function balance(g: Game<State>): void {
  placeStragglers(g);
  const sizes = liveSizes(g);
  for (;;) {
    const most = Math.max(...sizes);
    const least = Math.min(...sizes);
    if (most - least <= 1) return;
    const from = sizes.indexOf(most);
    const to = sizes.indexOf(least);
    const mover = [...members(g, from)].reverse().find((p) => p.connected)!;
    g.state.teamOf[mover.id] = to;
    sizes[from] -= 1;
    sizes[to] += 1;
  }
}

function pickPrompts(g: Game<State>, packs: Pack[]): string[] {
  const all = packs.find((entry) => entry.id === g.state.config.pack)?.prompts ?? [];
  let fresh = all.filter((prompt) => !g.state.used.includes(prompt));
  if (fresh.length < Math.min(g.state.config.rounds, all.length)) {
    // The pack ran out: start over rather than play a short game.
    g.state.used = g.state.used.filter((prompt) => !all.includes(prompt));
    fresh = all;
  }
  const picked = shuffle(fresh).slice(0, g.state.config.rounds);
  g.state.used.push(...picked);
  return picked;
}

function beginRound(g: Game<State>): void {
  const { teams } = g.state.config;
  const count = answeringCount(g.state.config);
  // Take turns in order, so every crew answers equally often.
  g.state.answering = Array.from({ length: count }, (_, i) => (g.state.cursor + i) % teams).sort((a, b) => a - b);
  g.state.cursor = (g.state.cursor + count) % teams;
  g.state.answers = {};
  g.state.ballot = [];
  g.state.votes = {};
  g.state.winners = [];
  g.state.eligible = 0;
  g.state.typing = {};
  g.state.openVote = false;
  g.state.phase = "write";
  g.timer("write", WRITE_MS, () => beginVote(g));
}

function beginVote(g: Game<State>): void {
  g.clearTimer("write");
  g.state.typing = {};
  g.state.ballot = shuffle(g.state.answering.filter((team) => team in g.state.answers));
  if (g.state.ballot.length < 2) {
    // Nothing to choose between: a lone answer wins the round unopposed.
    finishRound(g, g.state.ballot);
    return;
  }
  g.state.phase = "vote";
  g.state.openVote = !g.players.some((p) => {
    const team = g.state.teamOf[p.id];
    return p.connected && team !== undefined && othersOnBallot(g, team).length >= 2;
  });
  g.timer("vote", VOTE_MS, () => tally(g));
}

const votesFor = (g: Game<State>, team: number): number =>
  Object.values(g.state.votes).filter((vote) => vote === team).length;

function tally(g: Game<State>): void {
  g.clearTimer("vote");
  const counts = g.state.ballot.map((team) => votesFor(g, team));
  const most = Math.max(0, ...counts);
  // A tie for first scores for every tied crew; no votes at all scores for nobody.
  finishRound(g, most === 0 ? [] : g.state.ballot.filter((_, i) => counts[i] === most));
}

function finishRound(g: Game<State>, winners: number[]): void {
  // Anyone who voted counts as eligible, even if their phone dropped since.
  g.state.eligible = g.state.ballot.length >= 2 ? new Set([...voters(g).map((p) => p.id), ...Object.keys(g.state.votes)]).size : 0;
  g.state.winners = winners;
  for (const team of winners) g.state.scores[team] += 1;
  g.state.history.push({
    eligible: g.state.eligible,
    contested: g.state.ballot.length >= 2,
    answers: g.state.ballot.map((team) => ({ ...g.state.answers[team], team, votes: votesFor(g, team) })),
  });
  g.state.phase = "result";
}

function advance(g: Game<State>): void {
  g.state.round += 1;
  if (g.state.round < g.state.prompts.length) beginRound(g);
  else g.state.phase = "end";
}

function standings(g: Game<State>) {
  return teamIndexes(g)
    .map((team) => ({ team, name: CREWS[team], score: g.state.scores[team] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.team - b.team);
}

/** 1 for the top score; crews on equal scores share a place. */
const placeOf = (g: Game<State>, team: number): number =>
  standings(g).filter((entry) => entry.score > (g.state.scores[team] ?? 0)).length + 1;

/** Crews with the top score at the end. More than one means a draw. */
function champions(g: Game<State>): number[] {
  const board = standings(g);
  return board.filter((entry) => entry.score === board[0].score).map((entry) => entry.team);
}

const nameOf = (g: Game<State>, id: string): string => g.players.find((p) => p.id === id)?.name ?? "Someone";

/**
 * End-of-show awards. Each is left out when nobody earned it.
 * - zinger: the answer with the most votes in one round (ties: the bigger share, then the earlier round).
 * - crickets: whoever sent the most answers that drew no votes on a ballot others did vote on.
 * - heckler: whoever heckled the most (three or more).
 */
export function awards(g: Game<State>) {
  let zinger: { text: string; by: string; team: number; votes: number; eligible: number } | null = null;
  const crickets = new Map<string, { name: string; team: number; count: number }>();
  for (const round of g.state.history) {
    if (!round.contested) continue;
    // A round nobody voted in (the timer ran out) is nobody's fault.
    const anyVotes = round.answers.some((answer) => answer.votes > 0);
    for (const answer of round.answers) {
      if (answer.votes > 0) {
        const share = answer.votes / Math.max(1, round.eligible);
        const best = zinger ? zinger.votes / Math.max(1, zinger.eligible) : 0;
        if (!zinger || answer.votes > zinger.votes || (answer.votes === zinger.votes && share > best)) {
          zinger = { text: answer.text, by: answer.by, team: answer.team, votes: answer.votes, eligible: round.eligible };
        }
      } else if (anyVotes) {
        const entry = crickets.get(answer.byId) ?? { name: answer.by, team: answer.team, count: 0 };
        entry.count += 1;
        crickets.set(answer.byId, entry);
      }
    }
  }
  let quiet: { name: string; team: number; count: number } | null = null;
  for (const entry of crickets.values()) if (!quiet || entry.count > quiet.count) quiet = entry;

  let heckler: { name: string; team: number | null; count: number } | null = null;
  for (const [id, count] of Object.entries(g.state.heckles)) {
    if (count >= 3 && (!heckler || count > heckler.count)) {
      heckler = { name: nameOf(g, id), team: g.state.teamOf[id] ?? null, count };
    }
  }
  return { zinger, crickets: quiet, heckler };
}

const showsPrompt = (phase: State["phase"]): boolean => phase === "write" || phase === "vote" || phase === "result";

function clock(g: Game<State>) {
  const { phase } = g.state;
  if (phase === "write") return { deadline: g.deadline("write") ?? null, duration: WRITE_MS };
  if (phase === "vote") return { deadline: g.deadline("vote") ?? null, duration: VOTE_MS };
  return { deadline: null, duration: 0 };
}

/** "arcade.goobta.io/FROG": where latecomers join, without the scheme. */
function joinAddress(code: string, publicUrl: string | undefined): string {
  try {
    const url = new URL(publicUrl ?? "");
    return `${url.host}/${code}`;
  } catch {
    return code;
  }
}

export function initialState(packs: Pack[]): State {
  return {
    phase: "lobby",
    config: { teams: 2, answering: 2, rounds: 5, pack: packs[0]?.id ?? "" },
    teamOf: {},
    scores: [],
    prompts: [],
    round: 0,
    used: [],
    cursor: 0,
    answering: [],
    answers: {},
    ballot: [],
    openVote: false,
    votes: {},
    winners: [],
    eligible: 0,
    typing: {},
    heckledAt: {},
    heckleWindow: [],
    heckles: {},
    history: [],
  };
}

export function createDefinition(packs: Pack[] = loadPacks()): GameDefinition<State> {
  const packList = packs.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    count: entry.prompts.length,
  }));

  return {
    init: () => initialState(packs),

    onHost: {
      /** Change any of the lobby settings: { teams?, answering?, rounds?, pack? }. */
      configure(g, data) {
        if (g.state.phase !== "lobby" || !data || typeof data !== "object") return;
        const config = g.state.config;
        const { teams, answering, rounds, pack: packId } = data as Record<string, unknown>;
        if (Number.isInteger(teams) && (teams as number) >= MIN_CREWS && (teams as number) <= MAX_CREWS) {
          config.teams = teams as number;
          // Players on a crew that no longer exists pick again.
          for (const [id, team] of Object.entries(g.state.teamOf)) if (team >= config.teams) delete g.state.teamOf[id];
        }
        if (answering === "all") config.answering = "all";
        else if (Number.isInteger(answering) && (answering as number) >= 2 && (answering as number) <= MAX_CREWS) {
          config.answering = answering as number;
        }
        if (Number.isInteger(rounds) && (rounds as number) >= 1 && (rounds as number) <= MAX_ROUNDS) {
          config.rounds = rounds as number;
        }
        if (typeof packId === "string" && packs.some((entry) => entry.id === packId)) config.pack = packId;
      },

      /** Deal everyone into crews at random, as evenly as possible. */
      shuffle(g) {
        if (g.state.phase !== "lobby") return;
        g.state.teamOf = {};
        shuffle(g.players).forEach((player, i) => {
          g.state.teamOf[player.id] = i % g.state.config.teams;
        });
      },

      /** Even out the crews, moving as few people as possible. */
      balance(g) {
        if (g.state.phase !== "lobby") return;
        balance(g);
      },

      start(g) {
        if (g.state.phase !== "lobby" && g.state.phase !== "end") return;
        if (startProblem(g, packs)) return;
        // Anyone still dithering when the curtain goes up joins the smallest crew.
        placeStragglers(g);
        g.state.prompts = pickPrompts(g, packs);
        g.state.round = 0;
        g.state.scores = teamIndexes(g).map(() => 0);
        g.state.cursor = 0;
        g.state.history = [];
        g.state.heckles = {};
        beginRound(g);
      },

      /** Move on without waiting: writing -> voting -> results -> next round. */
      next(g) {
        if (g.state.phase === "write") beginVote(g);
        else if (g.state.phase === "vote") tally(g);
        else if (g.state.phase === "result") advance(g);
      },

      /** From the final scores back to the lobby, to change crews or settings. */
      lobby(g) {
        if (g.state.phase === "end") g.state.phase = "lobby";
      },

      exit(g) {
        g.end();
      },
    },

    onPlayer: {
      /** Pick a crew. Switching is only possible in the lobby; latecomers can pick at any time. */
      join(g, player, team) {
        if (!Number.isInteger(team) || team < 0 || team >= g.state.config.teams) return;
        if (g.state.phase !== "lobby" && player.id in g.state.teamOf) return;
        g.state.teamOf[player.id] = team;
      },

      /** One answer per crew: the first teammate to send it locks it in. */
      answer(g, player, text) {
        const team = g.state.teamOf[player.id];
        if (g.state.phase !== "write" || team === undefined || !g.state.answering.includes(team)) return;
        if (team in g.state.answers || typeof text !== "string") return;
        const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER);
        if (clean === "") return;
        g.state.answers[team] = { text: clean, by: player.name, byId: player.id };
        for (const p of members(g, team)) delete g.state.typing[p.id];
        if (g.state.answering.every((entry) => entry in g.state.answers)) beginVote(g);
      },

      /** A writer's phone says "typing", "idea" (paused with a draft) or "idle". Teammates and the projector see it. */
      typing(g, player, status) {
        const team = g.state.teamOf[player.id];
        if (g.state.phase !== "write" || team === undefined || !g.state.answering.includes(team)) return;
        if (team in g.state.answers) return;
        if (status === "typing" || status === "idea") g.state.typing[player.id] = status;
        else delete g.state.typing[player.id];
      },

      /** A reaction from a phone whose crew is not writing this round, shown on the projector. */
      heckle(g, player, kind) {
        const team = g.state.teamOf[player.id];
        if (g.state.phase !== "write" || team === undefined || g.state.answering.includes(team)) return;
        if (typeof kind !== "string" || !HECKLES.includes(kind)) return;
        const now = Date.now();
        if (now - (g.state.heckledAt[player.id] ?? 0) < HECKLE_GAP_MS) return;
        g.state.heckleWindow = g.state.heckleWindow.filter((at) => now - at < 1_000);
        if (g.state.heckleWindow.length >= HECKLES_PER_SECOND) return;
        g.state.heckleWindow.push(now);
        g.state.heckledAt[player.id] = now;
        g.state.heckles[player.id] = (g.state.heckles[player.id] ?? 0) + 1;
        g.send("host", "heckle", { kind, name: player.name, team });
      },

      /** `index` is a position on the ballot, which hides whose answer is whose. */
      vote(g, player, index) {
        if (g.state.phase !== "vote" || player.id in g.state.votes) return;
        const team = g.state.ballot[index];
        if (team === undefined || !choices(g, player).includes(team)) return;
        g.state.votes[player.id] = team;
        const waiting = voters(g).filter((p) => !(p.id in g.state.votes));
        if (waiting.length === 0) tally(g);
      },
    },

    onLeave(g, player) {
      delete g.state.typing[player.id];
    },

    hostView(g) {
      const { phase, config, prompts, round, answering, answers, ballot, votes, winners, teamOf, typing } = g.state;
      const canVote = voters(g);
      // Voters in the order they voted, then everyone still deciding.
      const voted = Object.keys(votes);
      const pending = canVote.filter((p) => !(p.id in votes));
      return {
        phase,
        code: g.code,
        join: joinAddress(g.code, process.env.ARCADE_PUBLIC_URL),
        round: round + 1,
        total: prompts.length || config.rounds,
        config,
        packs: packList,
        players: g.players.length,
        teams: teamIndexes(g).map((team) => ({
          index: team,
          name: CREWS[team],
          score: g.state.scores[team] ?? 0,
          members: members(g, team).map((p) => ({
            name: p.name,
            connected: p.connected,
            typing: phase === "write" ? (typing[p.id] ?? null) : null,
          })),
          // Who writes this round. Public anyway: the projector showed it while they wrote.
          answering: (phase === "write" || phase === "vote") && answering.includes(team),
          submitted: phase === "write" && team in answers,
          sentBy: phase === "write" ? (answers[team]?.by ?? null) : null,
        })),
        unassigned: g.players.filter((p) => !(p.id in teamOf)).map((p) => p.name),
        problem: startProblem(g, packs),
        prompt: showsPrompt(phase) ? (prompts[round] ?? null) : null,
        ...clock(g),
        // The ballot never says whose answer is whose, so the projector cannot leak it.
        ballot: phase === "vote" ? ballot.map((team) => answers[team].text) : null,
        openVote: phase === "vote" && g.state.openVote,
        votesIn: voted.length,
        voters: phase === "vote" ? new Set([...voted, ...canVote.map((p) => p.id)]).size : 0,
        voterList:
          phase === "vote"
            ? [
                ...voted.map((id) => ({ name: nameOf(g, id), team: teamOf[id] ?? null, voted: true })),
                ...pending.map((p) => ({ name: p.name, team: teamOf[p.id] ?? null, voted: false })),
              ]
            : null,
        results:
          phase === "result"
            ? answering
                .map((team) => ({
                  team,
                  name: CREWS[team],
                  text: answers[team]?.text ?? null,
                  by: answers[team]?.by ?? null,
                  voters: g.players
                    .filter((p) => votes[p.id] === team)
                    .map((p) => ({ name: p.name, team: teamOf[p.id] ?? null })),
                  won: winners.includes(team),
                }))
                .sort((a, b) => b.voters.length - a.voters.length || a.team - b.team)
            : null,
        eligible: phase === "result" ? g.state.eligible : 0,
        unopposed: phase === "result" && ballot.length === 1,
        standings: standings(g),
        champions: phase === "end" ? champions(g) : null,
        awards: phase === "end" ? awards(g) : null,
      };
    },

    playerView(g, player) {
      const { phase, config, prompts, round, answering, answers, ballot, votes, winners, teamOf, typing } = g.state;
      const team: number | undefined = teamOf[player.id];
      const mine = choices(g, player);
      const voted = votes[player.id];
      const writing = phase === "write" && team !== undefined && answering.includes(team);
      const pending = phase === "vote" ? voters(g).filter((p) => !(p.id in votes)) : [];
      const ownAnswer = team !== undefined ? answers[team] : undefined;
      return {
        phase,
        name: player.name,
        round: round + 1,
        total: prompts.length || config.rounds,
        team: team ?? null,
        teamName: team === undefined ? null : CREWS[team],
        score: team === undefined ? 0 : (g.state.scores[team] ?? 0),
        canSwitch: phase === "lobby",
        teams: teamIndexes(g).map((index) => ({
          index,
          name: CREWS[index],
          members: members(g, index).map((p) => p.name),
        })),
        prompt: showsPrompt(phase) ? (prompts[round] ?? null) : null,
        ...clock(g),
        writing:
          phase === "write"
            ? {
                up: writing,
                // Only the crew that wrote it sees an answer before the vote.
                answer: ownAnswer ? { text: ownAnswer.text, by: ownAnswer.by } : null,
                teams: answering.map((entry) => CREWS[entry]),
                max: MAX_ANSWER,
                teammates: writing
                  ? members(g, team)
                      .filter((p) => p.id !== player.id && p.connected)
                      .map((p) => ({ name: p.name, typing: typing[p.id] ?? null }))
                  : [],
                heckles: writing ? [] : HECKLES,
                heckleGap: HECKLE_GAP_MS,
              }
            : null,
        voting:
          phase === "vote"
            ? {
                canVote: mine.length > 0,
                options: ballot.map((entry, index) => ({
                  index,
                  text: answers[entry].text,
                  own: entry === team,
                  allowed: mine.includes(entry),
                })),
                picked: voted === undefined ? null : ballot.indexOf(voted),
                waitingOn: pending.slice(0, 2).map((p) => p.name),
                waiting: pending.length,
              }
            : null,
        result:
          phase === "result"
            ? {
                won: team !== undefined && winners.includes(team),
                winners: winners.map((entry) => CREWS[entry]),
                answers: answering
                  .filter((entry) => entry in answers)
                  .map((entry) => ({ name: CREWS[entry], text: answers[entry].text })),
                // This crew's own answer, if it wrote one this round.
                mine:
                  team !== undefined && ownAnswer && ballot.includes(team)
                    ? { text: ownAnswer.text, by: ownAnswer.by, votes: votesFor(g, team), eligible: g.state.eligible }
                    : null,
                unopposed: ballot.length === 1,
                place: team === undefined ? null : placeOf(g, team),
              }
            : null,
        end:
          phase === "end"
            ? {
                won: team !== undefined && champions(g).includes(team),
                champions: champions(g).map((entry) => CREWS[entry]),
                place: team === undefined ? null : placeOf(g, team),
                awards: awards(g),
              }
            : null,
      };
    },
  };
}
