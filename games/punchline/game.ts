// Punchline: crews write the funniest answer to a prompt, everyone votes, and
// the answer with the most votes scores for its crew.
//
// The host chooses how many crews there are (2 to 6), how many rounds to play,
// and where the prompts come from: a question pack (the JSON files in
// ./questions: drop another one in and it shows up in the lobby the next time
// the game is opened) or, when ANTHROPIC_API_KEY is set, prompts written for
// this show by Claude from a theme and a spice level.
//
// Every round has two stages. In the crew stage everybody writes and locks an
// answer, then votes among their teammates' answers; each crew's favourite is
// published. In the final vote every published answer goes up anonymously and
// the whole room votes.
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
  /** A look the clients know how to dress the show in (a key of THEMES), or null for the usual stage. */
  theme: string | null;
  /** The guest of honour's seat, or null for a show without one. */
  vip: Vip | null;
  prompts: string[];
}

/**
 * A guest of honour: one player may take this seat, watch or join a crew, and
 * their votes on the final ballot count for more.
 */
export interface Vip {
  /** What the seat is called: "Birthday Boy", "Guest of Honour". */
  title: string;
  /** What each of their final-ballot votes is worth. */
  votes: number;
}

export const VIP_TITLE = "Guest of Honour";
export const VIP_VOTES = 3;
const MAX_VIP_VOTES = 9;

/** A pack's "vip": true for the defaults, or { "title": "...", "votes": 3 }. Anything else is no seat. */
function parseVip(raw: unknown): Vip | null {
  if (raw === true) return { title: VIP_TITLE, votes: VIP_VOTES };
  if (!raw || typeof raw !== "object") return null;
  const { title, votes } = raw as Record<string, unknown>;
  return {
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 24) : VIP_TITLE,
    votes: Number.isInteger(votes) && (votes as number) >= 1 && (votes as number) <= MAX_VIP_VOTES ? (votes as number) : VIP_VOTES,
  };
}

/**
 * Looks a pack can ask for with "theme": "...". The clients hold the art and
 * copy under the same key; the server only needs the crew names.
 */
export const THEMES: Record<string, { crews: string[] }> = {
  raju60: { crews: ["Gulab Jamuns", "Kulfis", "Ladoos", "Barfis", "Faloodas", "Jalebis"] },
};

const PACK_DIR = path.join(import.meta.dirname, "questions");
const MAX_PROMPT = 200;

/** One pack file: { "name": "...", "description": "...", "theme": "...", "vip": { ... }, "prompts": ["...", { "text": "..." }] } */
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
    // An unknown theme is dropped, so the pack still plays on the usual stage.
    theme: typeof file.theme === "string" && Object.hasOwn(THEMES, file.theme) ? file.theme : null,
    vip: parseVip(file.vip),
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
      const raw = JSON.parse(readFileSync(path.join(PACK_DIR, name), "utf8"));
      const pack = parsePack(name.slice(0, -".json".length), raw);
      if (typeof raw?.theme === "string" && !pack.theme) {
        console.error(`[punchline] questions/${name}: unknown theme "${raw.theme}", using the usual stage`);
      }
      packs.push(pack);
    } catch (error) {
      // A broken pack must not hide the good ones.
      console.error(`[punchline] skipped questions/${name}: ${(error as Error).message}`);
    }
  }
  return packs;
}

// ---------- rules ----------

/** Crew names, in the order crews are added. The clients pair each with a mascot and colour. */
export const CREWS = ["Hot Sauce", "Blueberries", "Lemons", "Pickles", "Grapes", "Tangerines"];
export const MIN_CREWS = 2;
export const MAX_CREWS = CREWS.length;

/** A crew's name in the show's current look. */
function crewName(g: Game<State>, team: number): string {
  return (g.state.theme ? THEMES[g.state.theme]?.crews[team] : undefined) ?? CREWS[team];
}
const MAX_ROUNDS = 20;
export const MAX_ANSWER = 100;
/** The crew stage: this long to write and lock an answer... */
export const WRITE_MS = 25_000;
/** ...and this long in all, so the last five seconds are for voting only. */
export const TEAM_MS = 30_000;
export const VOTE_MS = 20_000;
/** From this many crews up, everyone gets two votes on the final ballot. */
export const TWO_VOTE_CREWS = 4;

/** What a phone that has locked its answer can shout at the stage. */
export const HECKLES = ["HA!", "OOF", "WOW", "*clap*", "BOO", "zzz"];
/** One heckle per phone this often, at most. */
export const HECKLE_GAP_MS = 1_000;
/** And at most this many reach the projector in any one second, however big the room. */
export const HECKLES_PER_SECOND = 8;

/** The AI prompt writer's appropriateness slider, mildest first. */
export const AI_LEVELS = ["Unc", "Clean", "Cheeky", "Spicy", "NSFW"];
export const MAX_THEME = 200;
/** How many already-played prompts the AI is told to steer clear of. */
const AVOID_MAX = 60;

export interface PromptRequest {
  /** What the host typed; empty means a general party. Untrusted text. */
  theme: string;
  /** Index into AI_LEVELS. */
  level: number;
  count: number;
  /** Prompts already played, not to be repeated. */
  avoid: string[];
}

export interface Options {
  /** Whether the lobby offers AI prompts. Defaults to whether ANTHROPIC_API_KEY is set. */
  aiAvailable?: boolean;
  /** Writes the prompts. Defaults to ./ai.ts, loaded only when first needed. */
  generate?: (request: PromptRequest) => Promise<string[]>;
}

interface Config {
  teams: number;
  rounds: number;
  pack: string;
  /** Where prompts come from. "ai" only counts while the AI writer is available. */
  source: "pack" | "ai";
  aiTheme: string;
  aiLevel: number;
}

/** What a writer's phone last said about them: typing now, or paused with a draft. */
type Typing = "typing" | "idea";

/** One played round, kept for the end-of-show awards. */
interface RoundRecord {
  /** The votes one answer could have drawn when the round was tallied: one per voter, more for the guest of honour. */
  eligible: number;
  /** False when a lone answer scored unopposed: nobody had a choice to make. */
  contested: boolean;
  answers: { team: number; text: string; by: string; byId: string; votes: number }[];
}

export interface State {
  phase: "lobby" | "generating" | "team" | "vote" | "result" | "end";
  config: Config;
  /** The chosen pack's look, or null: the usual stage, and always for AI prompts. */
  theme: string | null;
  /** The chosen pack's guest-of-honour seat, or null: no seat, and always for AI prompts. */
  vip: Vip | null;
  /** Who holds the seat. It only counts while `vip` is set. */
  vipId: string | null;
  /** Player id -> crew index. Players not in here have not picked a crew yet (or are the guest of honour, watching). */
  teamOf: Record<string, number>;
  scores: number[];
  prompts: string[];
  round: number;
  /** Prompts already played since the game was opened, so "play again" brings new ones. */
  used: string[];
  /** Crew stage: true for the first WRITE_MS, while answers can still be locked. */
  writeOpen: boolean;
  /** Crew stage: player id -> their locked answer. `order` counts up, so the earliest lock is the lowest. */
  locked: Record<string, { text: string; order: number }>;
  lockCount: number;
  /** Crew stage: voter id -> the teammate whose answer they back. */
  teamVotes: Record<string, string>;
  /** Crew index -> the answer its crew published. */
  answers: Record<number, { text: string; by: string; byId: string }>;
  /** Crews with an answer, in the shuffled order shown on the ballot. */
  ballot: number[];
  /** Player id -> the crews they voted for, oldest pick first. Keys are in the order players first voted. */
  votes: Record<string, number[]>;
  winners: number[];
  /** The votes one answer could have drawn this round, counted when it was tallied. */
  eligible: number;
  /** Writers who are typing or have a draft. */
  typing: Record<string, Typing>;
  /** Player id -> when they last heckled (epoch ms). */
  heckledAt: Record<string, number>;
  /** When the most recent heckles reached the projector, for the room-wide limit. */
  heckleWindow: number[];
  /** Player id -> heckles sent this show. */
  heckles: Record<string, number>;
  history: RoundRecord[];
  /** Counts AI requests, so an answer that arrives after a cancel is ignored. */
  generation: number;
  /** Why the last AI request failed, shown in the lobby. */
  aiError: string | null;
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

/** Whether this player holds the guest-of-honour seat in a show that has one. */
const isVip = (g: Game<State>, id: string): boolean => g.state.vip !== null && g.state.vipId === id;

/** The guest of honour without a crew: they watch the crew stage and vote on the final ballot. */
const watching = (g: Game<State>, id: string): boolean => isVip(g, id) && g.state.teamOf[id] === undefined;

/** What one of this player's final-ballot votes is worth. */
const weightOf = (g: Game<State>, id: string): number => (isVip(g, id) ? g.state.vip!.votes : 1);

/** Votes each player gets on the final ballot. */
export const votesPerPlayer = (config: Config): number => (config.teams >= TWO_VOTE_CREWS ? 2 : 1);

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
    // The guest of honour chose to watch: nobody drafts them.
    if (!p.connected || p.id in g.state.teamOf || isVip(g, p.id)) continue;
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
    // The guest of honour sits where they chose. A crew this much bigger always has someone else to move.
    const mover = [...members(g, from)].reverse().find((p) => p.connected && !isVip(g, p.id))!;
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
  return shuffle(fresh).slice(0, g.state.config.rounds);
}

/** The curtain goes up on a fresh show with these prompts. */
function raiseCurtain(g: Game<State>, prompts: string[]): void {
  g.state.used.push(...prompts);
  g.state.prompts = prompts;
  g.state.round = 0;
  g.state.scores = teamIndexes(g).map(() => 0);
  g.state.history = [];
  g.state.heckles = {};
  beginRound(g);
}

// ----- the crew stage -----

function beginRound(g: Game<State>): void {
  g.state.locked = {};
  g.state.lockCount = 0;
  g.state.teamVotes = {};
  g.state.answers = {};
  g.state.ballot = [];
  g.state.votes = {};
  g.state.winners = [];
  g.state.eligible = 0;
  g.state.typing = {};
  g.state.phase = "team";
  g.state.writeOpen = true;
  g.timer("write", WRITE_MS, () => {
    g.state.writeOpen = false;
    g.state.typing = {};
  });
  g.timer("team", TEAM_MS, () => publish(g));
}

/** The teammates whose locked answers this player could back: never their own. */
function candidates(g: Game<State>, player: Player): Player[] {
  const team = g.state.teamOf[player.id];
  if (g.state.phase !== "team" || team === undefined) return [];
  return members(g, team).filter((p) => p.id !== player.id && p.id in g.state.locked);
}

/** Voting opens for you once your own answer is locked, and for everyone when writing closes. */
const canTeamVote = (g: Game<State>, player: Player): boolean =>
  (player.id in g.state.locked || !g.state.writeOpen) && candidates(g, player).length > 0;

const teamVotesFor = (g: Game<State>, author: string): number =>
  Object.values(g.state.teamVotes).filter((vote) => vote === author).length;

/** Nothing left to wait for: everyone here has locked an answer and backed one (or has nobody to back). */
function crewStageDone(g: Game<State>): boolean {
  const here = g.players.filter((p) => p.connected && g.state.teamOf[p.id] !== undefined);
  return (
    here.length > 0 &&
    here.every(
      (p) =>
        (p.id in g.state.locked || !g.state.writeOpen) &&
        (candidates(g, p).length === 0 || p.id in g.state.teamVotes),
    )
  );
}

/**
 * Each crew publishes its locked answer with the most teammate votes; on a tie
 * the one locked first wins. A crew with nothing locked sits the round out.
 */
function publish(g: Game<State>): void {
  g.clearTimer("write");
  g.clearTimer("team");
  g.state.writeOpen = false;
  g.state.typing = {};
  for (const team of teamIndexes(g)) {
    let best: { player: Player; votes: number; order: number } | null = null;
    for (const player of members(g, team)) {
      const entry = g.state.locked[player.id];
      if (!entry) continue;
      const votes = teamVotesFor(g, player.id);
      if (!best || votes > best.votes || (votes === best.votes && entry.order < best.order)) {
        best = { player, votes, order: entry.order };
      }
    }
    if (best) g.state.answers[team] = { text: g.state.locked[best.player.id].text, by: best.player.name, byId: best.player.id };
  }
  beginVote(g);
}

// ----- the final vote -----

function beginVote(g: Game<State>): void {
  g.state.ballot = shuffle(teamIndexes(g).filter((team) => team in g.state.answers));
  if (g.state.ballot.length < 2) {
    // Nothing to choose between: a lone answer wins the round unopposed.
    finishRound(g, g.state.ballot);
    return;
  }
  g.state.phase = "vote";
  g.timer("vote", VOTE_MS, () => tally(g));
}

/**
 * The crews this player may vote for: every answer but the one they wrote
 * themselves. It takes a crew to vote, or the guest of honour's seat.
 */
function choices(g: Game<State>, player: Player): number[] {
  if (g.state.phase !== "vote") return [];
  if (g.state.teamOf[player.id] === undefined && !watching(g, player.id)) return [];
  return g.state.ballot.filter((team) => g.state.answers[team].byId !== player.id);
}

/** How many votes this player can cast: one or two, but never more than they have answers to pick from. */
const voteLimit = (g: Game<State>, player: Player): number =>
  Math.min(votesPerPlayer(g.state.config), choices(g, player).length);

/** Connected players who may vote this round. */
const voters = (g: Game<State>): Player[] => g.players.filter((p) => p.connected && choices(g, p).length > 0);

const votesUsed = (g: Game<State>, player: Player): number => g.state.votes[player.id]?.length ?? 0;
const doneVoting = (g: Game<State>, player: Player): boolean => votesUsed(g, player) >= voteLimit(g, player);

/** An answer's votes: one per voter who picked it, more for the guest of honour. */
const votesFor = (g: Game<State>, team: number): number =>
  Object.entries(g.state.votes).reduce((sum, [id, picks]) => sum + (picks.includes(team) ? weightOf(g, id) : 0), 0);

function tally(g: Game<State>): void {
  g.clearTimer("vote");
  const counts = g.state.ballot.map((team) => votesFor(g, team));
  const most = Math.max(0, ...counts);
  // A tie for first scores for every tied crew; no votes at all scores for nobody.
  finishRound(g, most === 0 ? [] : g.state.ballot.filter((_, i) => counts[i] === most));
}

function finishRound(g: Game<State>, winners: number[]): void {
  // Anyone who voted counts as eligible, even if their phone dropped since.
  // Counted in votes, so it is the most any one answer could have drawn.
  const judges = new Set([...voters(g).map((p) => p.id), ...Object.keys(g.state.votes)]);
  g.state.eligible = g.state.ballot.length >= 2 ? [...judges].reduce((sum, id) => sum + weightOf(g, id), 0) : 0;
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
    .map((team) => ({ team, name: crewName(g, team), score: g.state.scores[team] ?? 0 }))
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
 * - crickets: whoever wrote the most published answers that drew no votes on a ballot others did vote on.
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

const showsPrompt = (phase: State["phase"]): boolean => phase === "team" || phase === "vote" || phase === "result";

function clock(g: Game<State>) {
  const { phase } = g.state;
  if (phase === "team") {
    const deadline = g.deadline("team") ?? null;
    return {
      deadline,
      duration: TEAM_MS,
      // When writing closes and the voting-only stretch begins.
      writeDeadline: deadline === null ? null : deadline - (TEAM_MS - WRITE_MS),
      writeDuration: WRITE_MS,
    };
  }
  if (phase === "vote") return { deadline: g.deadline("vote") ?? null, duration: VOTE_MS, writeDeadline: null, writeDuration: 0 };
  return { deadline: null, duration: 0, writeDeadline: null, writeDuration: 0 };
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
    config: { teams: 2, rounds: 5, pack: packs[0]?.id ?? "", source: "pack", aiTheme: "", aiLevel: 1 },
    theme: packs[0]?.theme ?? null,
    vip: packs[0]?.vip ?? null,
    vipId: null,
    teamOf: {},
    scores: [],
    prompts: [],
    round: 0,
    used: [],
    writeOpen: false,
    locked: {},
    lockCount: 0,
    teamVotes: {},
    answers: {},
    ballot: [],
    votes: {},
    winners: [],
    eligible: 0,
    typing: {},
    heckledAt: {},
    heckleWindow: [],
    heckles: {},
    history: [],
    generation: 0,
    aiError: null,
  };
}

export function createDefinition(packs: Pack[] = loadPacks(), options: Options = {}): GameDefinition<State> {
  const packList = packs.map((entry) => ({
    id: entry.id,
    name: entry.name,
    theme: entry.theme,
    vip: entry.vip,
    description: entry.description,
    count: entry.prompts.length,
  }));
  const aiAvailable = options.aiAvailable ?? !!process.env.ANTHROPIC_API_KEY;
  // Loaded on demand: a show that sticks to packs never needs the Anthropic SDK.
  const generate = options.generate ?? (async (request: PromptRequest) => (await import("./ai.ts")).generatePrompts(request));

  const usesAi = (g: Game<State>): boolean => aiAvailable && g.state.config.source === "ai";

  /** Why the game cannot start yet, or null when it can. */
  function startProblem(g: Game<State>): string | null {
    if (!usesAi(g) && !packs.some((entry) => entry.id === g.state.config.pack)) return "No question packs found.";
    const empty = teamIndexes(g).filter((team) => members(g, team).length === 0);
    if (empty.length > 0) return `Waiting for players on ${empty.map((team) => crewName(g, team)).join(", ")}.`;
    return null;
  }

  /** Ask Claude for this show's prompts; the curtain goes up when they arrive. */
  function writePrompts(g: Game<State>): void {
    const id = ++g.state.generation;
    const { aiTheme, aiLevel, rounds } = g.state.config;
    g.state.phase = "generating";
    const current = () => g.state.generation === id && g.state.phase === "generating";
    Promise.resolve()
      .then(() => generate({ theme: aiTheme, level: aiLevel, count: rounds, avoid: g.state.used.slice(-AVOID_MAX) }))
      .then(
        (prompts) => {
          if (!current()) return;
          raiseCurtain(g, prompts.slice(0, rounds));
          g.sync();
        },
        (error: unknown) => {
          if (!current()) return;
          console.error("[punchline] AI prompts failed:", error);
          const message = error instanceof Error && error.message ? error.message : "Something went wrong.";
          g.state.aiError = message.slice(0, 200);
          g.state.phase = "lobby";
          g.sync();
        },
      );
  }

  return {
    init: () => initialState(packs),

    onHost: {
      /** Change any of the lobby settings: { teams?, rounds?, pack?, source?, aiTheme?, aiLevel? }. */
      configure(g, data) {
        if (g.state.phase !== "lobby" || !data || typeof data !== "object") return;
        const config = g.state.config;
        const { teams, rounds, pack: packId, source, aiTheme, aiLevel } = data as Record<string, unknown>;
        if (Number.isInteger(teams) && (teams as number) >= MIN_CREWS && (teams as number) <= MAX_CREWS) {
          config.teams = teams as number;
          // Players on a crew that no longer exists pick again.
          for (const [id, team] of Object.entries(g.state.teamOf)) if (team >= config.teams) delete g.state.teamOf[id];
        }
        if (Number.isInteger(rounds) && (rounds as number) >= 1 && (rounds as number) <= MAX_ROUNDS) {
          config.rounds = rounds as number;
        }
        if (typeof packId === "string" && packs.some((entry) => entry.id === packId)) config.pack = packId;
        if (source === "pack" || (source === "ai" && aiAvailable)) config.source = source;
        if (typeof aiTheme === "string") config.aiTheme = aiTheme.replace(/\s+/g, " ").trim().slice(0, MAX_THEME);
        if (Number.isInteger(aiLevel) && (aiLevel as number) >= 0 && (aiLevel as number) < AI_LEVELS.length) {
          config.aiLevel = aiLevel as number;
        }
        const chosen = usesAi(g) ? undefined : packs.find((entry) => entry.id === config.pack);
        g.state.theme = chosen?.theme ?? null;
        // Whoever holds the seat keeps it if the host comes back to a pack that has one.
        g.state.vip = chosen?.vip ?? null;
        g.state.aiError = null;
      },

      /** Deal everyone into crews at random, as evenly as possible. */
      shuffle(g) {
        if (g.state.phase !== "lobby") return;
        // The guest of honour stays where they chose: on their crew, or watching.
        const vip = g.players.find((p) => isVip(g, p.id));
        const kept = vip ? g.state.teamOf[vip.id] : undefined;
        g.state.teamOf = {};
        if (vip && kept !== undefined) g.state.teamOf[vip.id] = kept;
        shuffle(g.players.filter((p) => p !== vip)).forEach((player, i) => {
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
        if (startProblem(g)) return;
        // Anyone still dithering when the curtain goes up joins the smallest crew.
        placeStragglers(g);
        g.state.aiError = null;
        if (usesAi(g)) writePrompts(g);
        else raiseCurtain(g, pickPrompts(g, packs));
      },

      /** Move on without waiting: crew stage -> final vote -> results -> next round. */
      next(g) {
        if (g.state.phase === "team") publish(g);
        else if (g.state.phase === "vote") tally(g);
        else if (g.state.phase === "result") advance(g);
      },

      /** Back to the lobby, to change crews or settings: from the final scores, or to stop waiting for the AI. */
      lobby(g) {
        if (g.state.phase === "generating") g.state.generation += 1;
        if (g.state.phase === "end" || g.state.phase === "generating") g.state.phase = "lobby";
      },

      /** Empty the guest-of-honour seat, when the wrong phone took it. Whoever held it keeps their crew. */
      unseat(g) {
        if (g.state.phase !== "lobby") return;
        g.state.vipId = null;
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

      /**
       * Take the guest-of-honour seat (true) or give it back (false). There is
       * one seat, first come first served. Once the show is running only a
       * latecomer without a crew can take it, and nobody can give it back.
       */
      vip(g, player, on) {
        if (!g.state.vip) return;
        if (on === false) {
          if (g.state.phase === "lobby" && g.state.vipId === player.id) g.state.vipId = null;
          return;
        }
        if (on !== true || (g.state.vipId !== null && g.state.vipId !== player.id)) return;
        if (g.state.phase !== "lobby" && player.id in g.state.teamOf) return;
        g.state.vipId = player.id;
      },

      /** The guest of honour leaves their crew to watch instead. Like switching crews, only in the lobby. */
      watch(g, player) {
        if (g.state.phase !== "lobby" || !isVip(g, player.id)) return;
        delete g.state.teamOf[player.id];
      },

      /** Lock in your own answer. One each, no take-backs; teammates see it straight away. */
      answer(g, player, text) {
        if (g.state.phase !== "team" || !g.state.writeOpen || g.state.teamOf[player.id] === undefined) return;
        if (player.id in g.state.locked || typeof text !== "string") return;
        const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER);
        if (clean === "") return;
        g.state.locked[player.id] = { text: clean, order: g.state.lockCount++ };
        delete g.state.typing[player.id];
        if (crewStageDone(g)) publish(g);
      },

      /** Back a teammate's locked answer, or switch to another. Never your own. */
      teamVote(g, player, authorId) {
        if (g.state.phase !== "team" || typeof authorId !== "string" || !canTeamVote(g, player)) return;
        if (!candidates(g, player).some((p) => p.id === authorId)) return;
        g.state.teamVotes[player.id] = authorId;
        if (crewStageDone(g)) publish(g);
      },

      /** A writer's phone says "typing", "idea" (paused with a draft) or "idle". Teammates and the projector see it. */
      typing(g, player, status) {
        if (g.state.phase !== "team" || !g.state.writeOpen || g.state.teamOf[player.id] === undefined) return;
        if (player.id in g.state.locked) return;
        if (status === "typing" || status === "idea") g.state.typing[player.id] = status;
        else delete g.state.typing[player.id];
      },

      /** A reaction from a phone that has locked its answer (or run out of time to, or is only watching), shown on the projector. */
      heckle(g, player, kind) {
        const team = g.state.teamOf[player.id];
        const spectating = watching(g, player.id);
        if (g.state.phase !== "team" || (team === undefined && !spectating)) return;
        // The guest of honour, watching, has nothing to write and can heckle from the start.
        if (!spectating && g.state.writeOpen && !(player.id in g.state.locked)) return;
        if (typeof kind !== "string" || !HECKLES.includes(kind)) return;
        const now = Date.now();
        if (now - (g.state.heckledAt[player.id] ?? 0) < HECKLE_GAP_MS) return;
        g.state.heckleWindow = g.state.heckleWindow.filter((at) => now - at < 1_000);
        if (g.state.heckleWindow.length >= HECKLES_PER_SECOND) return;
        g.state.heckleWindow.push(now);
        g.state.heckledAt[player.id] = now;
        g.state.heckles[player.id] = (g.state.heckles[player.id] ?? 0) + 1;
        g.send("host", "heckle", { kind, name: player.name, team: team ?? null, vip: isVip(g, player.id) });
      },

      /**
       * Tap an answer on the final ballot. `index` is a position on the ballot,
       * which hides whose answer is whose. Tapping a pick again takes it back;
       * a new pick past the limit replaces the oldest one.
       */
      vote(g, player, index) {
        if (g.state.phase !== "vote") return;
        const team = g.state.ballot[index];
        if (team === undefined || !choices(g, player).includes(team)) return;
        const picks = g.state.votes[player.id] ?? [];
        if (picks.includes(team)) picks.splice(picks.indexOf(team), 1);
        else {
          picks.push(team);
          if (picks.length > voteLimit(g, player)) picks.shift();
        }
        if (picks.length > 0) g.state.votes[player.id] = picks;
        else delete g.state.votes[player.id];
        if (voters(g).every((p) => doneVoting(g, p))) tally(g);
      },
    },

    onLeave(g, player) {
      delete g.state.typing[player.id];
      // The room may have been waiting on just this phone.
      if (g.state.phase === "team" && crewStageDone(g)) publish(g);
      else if (g.state.phase === "vote" && voters(g).length > 0 && voters(g).every((p) => doneVoting(g, p))) tally(g);
    },

    hostView(g) {
      const { phase, config, prompts, round, answers, ballot, votes, winners, teamOf, typing, locked, teamVotes } = g.state;
      const canVote = voters(g);
      // Voters who have used every vote, in the order they started voting, then everyone still deciding.
      const done = Object.keys(votes).filter((id) => {
        const player = g.players.find((p) => p.id === id);
        return !player || doneVoting(g, player);
      });
      const pending = canVote.filter((p) => !done.includes(p.id));
      const seat = g.state.vip;
      const holder = seat ? g.players.find((p) => p.id === g.state.vipId) : undefined;
      /** The guest of honour goes first wherever voters are listed. */
      const vipFirst = <T extends { vip: boolean }>(list: T[]): T[] => [...list.filter((v) => v.vip), ...list.filter((v) => !v.vip)];
      const writers = g.players.filter((p) => teamOf[p.id] !== undefined && (p.connected || p.id in locked));
      return {
        phase,
        code: g.code,
        join: joinAddress(g.code, process.env.ARCADE_PUBLIC_URL),
        round: round + 1,
        total: prompts.length || config.rounds,
        config,
        theme: g.state.theme,
        // The seat, and who is in it: on a crew, or watching (team: null).
        vip: seat
          ? {
              title: seat.title,
              votes: seat.votes,
              holder: holder ? { name: holder.name, team: teamOf[holder.id] ?? null, connected: holder.connected } : null,
            }
          : null,
        packs: packList,
        aiAvailable,
        aiLevels: AI_LEVELS,
        aiError: g.state.aiError,
        usesAi: usesAi(g),
        players: g.players.length,
        teams: teamIndexes(g).map((team) => {
          const crew = members(g, team);
          const writing = crew.filter((p) => p.connected || p.id in locked);
          const lockedIn = writing.filter((p) => p.id in locked).length;
          return {
            index: team,
            name: crewName(g, team),
            score: g.state.scores[team] ?? 0,
            members: crew.map((p) => ({
              name: p.name,
              connected: p.connected,
              vip: isVip(g, p.id),
              typing: phase === "team" ? (typing[p.id] ?? null) : null,
            })),
            // Progress only: the projector never sees an answer before the final vote.
            writers: phase === "team" ? writing.length : 0,
            locked: phase === "team" ? lockedIn : 0,
            teamVotes: phase === "team" ? crew.filter((p) => p.id in teamVotes).length : 0,
            submitted: phase === "team" && writing.length > 0 && lockedIn === writing.length,
          };
        }),
        unassigned: g.players.filter((p) => !(p.id in teamOf) && !isVip(g, p.id)).map((p) => p.name),
        problem: startProblem(g),
        prompt: showsPrompt(phase) ? (prompts[round] ?? null) : null,
        ...clock(g),
        writeOpen: phase === "team" && g.state.writeOpen,
        lockedIn: phase === "team" ? writers.filter((p) => p.id in locked).length : 0,
        writers: phase === "team" ? writers.length : 0,
        // The ballot never says whose answer is whose, so the projector cannot leak it.
        ballot: phase === "vote" ? ballot.map((team) => answers[team].text) : null,
        votesEach: votesPerPlayer(config),
        votesIn: done.length,
        voters: phase === "vote" ? new Set([...done, ...canVote.map((p) => p.id)]).size : 0,
        voterList:
          phase === "vote"
            ? vipFirst([
                ...done.map((id) => ({ name: nameOf(g, id), team: teamOf[id] ?? null, voted: true, vip: isVip(g, id) })),
                ...pending.map((p) => ({ name: p.name, team: teamOf[p.id] ?? null, voted: false, vip: isVip(g, p.id) })),
              ])
            : null,
        results:
          phase === "result"
            ? teamIndexes(g)
                .map((team) => ({
                  team,
                  name: crewName(g, team),
                  text: answers[team]?.text ?? null,
                  by: answers[team]?.by ?? null,
                  // Who picked it, and what those picks add up to.
                  voters: vipFirst(
                    g.players
                      .filter((p) => votes[p.id]?.includes(team))
                      .map((p) => ({ name: p.name, team: teamOf[p.id] ?? null, vip: isVip(g, p.id) })),
                  ),
                  votes: votesFor(g, team),
                  won: winners.includes(team),
                }))
                .sort((a, b) => b.votes - a.votes || Number(b.text !== null) - Number(a.text !== null) || a.team - b.team)
            : null,
        eligible: phase === "result" ? g.state.eligible : 0,
        unopposed: phase === "result" && ballot.length === 1,
        standings: standings(g),
        champions: phase === "end" ? champions(g) : null,
        awards: phase === "end" ? awards(g) : null,
      };
    },

    playerView(g, player) {
      const { phase, config, prompts, round, answers, ballot, votes, winners, teamOf, typing, locked, teamVotes } = g.state;
      const team: number | undefined = teamOf[player.id];
      const crew = team === undefined ? [] : members(g, team);
      const mine = choices(g, player);
      const picks = votes[player.id] ?? [];
      const limit = voteLimit(g, player);
      const pending = phase === "vote" ? voters(g).filter((p) => !doneVoting(g, p)) : [];
      const ownAnswer = team !== undefined ? answers[team] : undefined;
      const hasLocked = player.id in locked;
      const seat = g.state.vip;
      const holder = seat ? g.players.find((p) => p.id === g.state.vipId) : undefined;
      const spectating = watching(g, player.id);
      return {
        phase,
        name: player.name,
        theme: g.state.theme,
        // The guest-of-honour seat, if this show has one.
        vip: seat
          ? {
              title: seat.title,
              votes: seat.votes,
              mine: holder?.id === player.id,
              takenBy: holder && holder.id !== player.id ? holder.name : null,
              canClaim: !holder && (phase === "lobby" || team === undefined),
              canLeave: holder?.id === player.id && phase === "lobby",
            }
          : null,
        /** True for the guest of honour without a crew: no writing, but a vote on the final ballot. */
        watching: spectating,
        /** What one of this player's final-ballot votes is worth. */
        voteWeight: weightOf(g, player.id),
        round: round + 1,
        total: prompts.length || config.rounds,
        team: team ?? null,
        teamName: team === undefined ? null : crewName(g, team),
        score: team === undefined ? 0 : (g.state.scores[team] ?? 0),
        canSwitch: phase === "lobby",
        teams: teamIndexes(g).map((index) => ({
          index,
          name: crewName(g, index),
          members: members(g, index).map((p) => p.name),
        })),
        // The crew stage from the guest of honour's seat: nothing to write, plenty to heckle.
        spectate: phase === "team" && spectating ? { heckles: HECKLES, heckleGap: HECKLE_GAP_MS } : null,
        prompt: showsPrompt(phase) ? (prompts[round] ?? null) : null,
        ...clock(g),
        // The crew stage. Only this player's own crew is in here: other crews'
        // answers stay on their phones until the final vote.
        huddle:
          phase === "team" && team !== undefined
            ? {
                writeOpen: g.state.writeOpen,
                mine: locked[player.id]?.text ?? null,
                max: MAX_ANSWER,
                // Locked answers only, in the order they were locked. No live drafts.
                answers: crew
                  .filter((p) => p.id in locked)
                  .sort((a, b) => locked[a.id].order - locked[b.id].order)
                  .map((p) => ({
                    id: p.id,
                    text: locked[p.id].text,
                    byName: p.name,
                    votes: teamVotesFor(g, p.id),
                    mine: p.id === player.id,
                    picked: teamVotes[player.id] === p.id,
                  })),
                myVote: teamVotes[player.id] ?? null,
                canVote: canTeamVote(g, player),
                teammates: crew
                  .filter((p) => p.id !== player.id && p.connected && !(p.id in locked))
                  .map((p) => ({ name: p.name, typing: typing[p.id] ?? null })),
                heckles: hasLocked || !g.state.writeOpen ? HECKLES : [],
                heckleGap: HECKLE_GAP_MS,
              }
            : null,
        voting:
          phase === "vote"
            ? {
                canVote: mine.length > 0,
                limit,
                left: Math.max(0, limit - picks.length),
                options: ballot.map((entry, index) => ({
                  index,
                  text: answers[entry].text,
                  own: entry === team,
                  // The one answer nobody may vote for: their own.
                  yours: answers[entry].byId === player.id,
                  allowed: mine.includes(entry),
                  picked: picks.includes(entry),
                })),
                waitingOn: pending.slice(0, 2).map((p) => p.name),
                waiting: pending.length,
              }
            : null,
        result:
          phase === "result"
            ? {
                won: team !== undefined && winners.includes(team),
                winners: winners.map((entry) => crewName(g, entry)),
                answers: ballot.map((entry) => ({ name: crewName(g, entry), text: answers[entry].text })),
                // This crew's published answer, if it had one this round.
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
                champions: champions(g).map((entry) => crewName(g, entry)),
                place: team === undefined ? null : placeOf(g, team),
                awards: awards(g),
              }
            : null,
      };
    },
  };
}
