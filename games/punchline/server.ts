// Punchline: teams write the funniest answer to a prompt, everyone votes, and
// the answer with the most votes scores for its team.
//
// The host chooses how many teams there are (2 to 4), how many of them answer
// each round (2, 3 or all), how many rounds to play, and which question pack
// to use. Packs are the JSON files in ./questions: drop another one in and it
// shows up in the lobby the next time the game is opened.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { serve, type Game, type Player } from "@arcade/sdk";

// ---------- question packs ----------

interface Pack {
  id: string;
  name: string;
  description: string;
  prompts: string[];
}

const PACK_DIR = path.join(import.meta.dirname, "questions");
const MAX_PROMPT = 200;

/** One pack file: { "name": "...", "description": "...", "prompts": ["...", { "text": "..." }] } */
function parsePack(id: string, raw: unknown): Pack {
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

const PACKS = loadPacks();
const pack = (id: string): Pack | undefined => PACKS.find((candidate) => candidate.id === id);

// ---------- rules ----------

const TEAM_NAMES = ["Red", "Blue", "Yellow", "Green"];
const MIN_TEAMS = 2;
const MAX_TEAMS = TEAM_NAMES.length;
const MAX_ROUNDS = 20;
const MAX_ANSWER = 100;
const WRITE_MS = 90_000;
const VOTE_MS = 45_000;

interface Config {
  teams: number;
  /** How many teams write an answer each round. */
  answering: number | "all";
  rounds: number;
  pack: string;
}

interface State {
  phase: "lobby" | "write" | "vote" | "result" | "end";
  config: Config;
  /** Player id -> team index. Players not in here have not picked a team yet. */
  teamOf: Record<string, number>;
  scores: number[];
  prompts: string[];
  round: number;
  /** Prompts already played since the game was opened, so "play again" brings new ones. */
  used: string[];
  /** Next team in the rotation of who answers. */
  cursor: number;
  /** Teams writing this round. */
  answering: number[];
  /** Team index -> its answer. */
  answers: Record<number, { text: string; by: string }>;
  /** Teams with an answer, in the shuffled order shown on the ballot. */
  ballot: number[];
  /**
   * True when nobody has two answers to choose from besides their own (two
   * teams, both answering). Everyone then votes on everything, own team included.
   */
  openVote: boolean;
  /** Player id -> team voted for. */
  votes: Record<string, number>;
  winners: number[];
}

function shuffle<T>(items: readonly T[]): T[] {
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
function startProblem(g: Game<State>): string | null {
  if (!pack(g.state.config.pack)) return "No question packs found.";
  const empty = teamIndexes(g).filter((team) => members(g, team).length === 0);
  if (empty.length > 0) return `Waiting for players on ${empty.map((team) => TEAM_NAMES[team]).join(", ")}.`;
  return null;
}

/** Ballot entries a team's members could pick from if own answers are off limits. */
const othersOnBallot = (g: Game<State>, team: number): number[] => g.state.ballot.filter((entry) => entry !== team);

/** The teams this player may vote for; empty when they sit this vote out. */
function choices(g: Game<State>, player: Player): number[] {
  const team = g.state.teamOf[player.id];
  if (g.state.phase !== "vote" || team === undefined) return [];
  if (g.state.openVote) return g.state.ballot;
  // With a single other answer there is nothing to choose: that team's members sit out.
  const others = othersOnBallot(g, team);
  return others.length >= 2 ? others : [];
}

function pickPrompts(g: Game<State>): string[] {
  const all = pack(g.state.config.pack)?.prompts ?? [];
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
  // Take turns in order, so every team answers equally often.
  g.state.answering = Array.from({ length: count }, (_, i) => (g.state.cursor + i) % teams).sort();
  g.state.cursor = (g.state.cursor + count) % teams;
  g.state.answers = {};
  g.state.ballot = [];
  g.state.votes = {};
  g.state.winners = [];
  g.state.openVote = false;
  g.state.phase = "write";
  g.timer("write", WRITE_MS, () => beginVote(g));
}

function beginVote(g: Game<State>): void {
  g.clearTimer("write");
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

function tally(g: Game<State>): void {
  g.clearTimer("vote");
  const counts = g.state.ballot.map((team) => Object.values(g.state.votes).filter((vote) => vote === team).length);
  const most = Math.max(0, ...counts);
  // A tie for first scores for every tied team; no votes at all scores for nobody.
  finishRound(g, most === 0 ? [] : g.state.ballot.filter((_, i) => counts[i] === most));
}

function finishRound(g: Game<State>, winners: number[]): void {
  g.state.winners = winners;
  for (const team of winners) g.state.scores[team] += 1;
  g.state.phase = "result";
}

function advance(g: Game<State>): void {
  g.state.round += 1;
  if (g.state.round < g.state.prompts.length) beginRound(g);
  else g.state.phase = "end";
}

function standings(g: Game<State>) {
  return teamIndexes(g)
    .map((team) => ({ team, name: TEAM_NAMES[team], score: g.state.scores[team] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.team - b.team);
}

/** Teams with the top score at the end. More than one means a draw. */
function champions(g: Game<State>): number[] {
  const board = standings(g);
  return board.filter((entry) => entry.score === board[0].score).map((entry) => entry.team);
}

const showsPrompt = (phase: State["phase"]): boolean => phase === "write" || phase === "vote" || phase === "result";

function clock(g: Game<State>) {
  const { phase } = g.state;
  if (phase === "write") return { deadline: g.deadline("write") ?? null, duration: WRITE_MS };
  if (phase === "vote") return { deadline: g.deadline("vote") ?? null, duration: VOTE_MS };
  return { deadline: null, duration: 0 };
}

serve<State>({
  init: () => ({
    phase: "lobby",
    config: { teams: 2, answering: 2, rounds: 5, pack: PACKS[0]?.id ?? "" },
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
  }),

  onHost: {
    /** Change any of the lobby settings: { teams?, answering?, rounds?, pack? }. */
    configure(g, data) {
      if (g.state.phase !== "lobby" || !data || typeof data !== "object") return;
      const config = g.state.config;
      const { teams, answering, rounds, pack: packId } = data as Record<string, unknown>;
      if (Number.isInteger(teams) && (teams as number) >= MIN_TEAMS && (teams as number) <= MAX_TEAMS) {
        config.teams = teams as number;
        // Players on a team that no longer exists pick again.
        for (const [id, team] of Object.entries(g.state.teamOf)) if (team >= config.teams) delete g.state.teamOf[id];
      }
      if (answering === "all") config.answering = "all";
      else if (Number.isInteger(answering) && (answering as number) >= 2 && (answering as number) <= MAX_TEAMS) {
        config.answering = answering as number;
      }
      if (Number.isInteger(rounds) && (rounds as number) >= 1 && (rounds as number) <= MAX_ROUNDS) {
        config.rounds = rounds as number;
      }
      if (typeof packId === "string" && pack(packId)) config.pack = packId;
    },

    /** Deal everyone into teams at random, as evenly as possible. */
    shuffle(g) {
      if (g.state.phase !== "lobby") return;
      g.state.teamOf = {};
      shuffle(g.players).forEach((player, i) => {
        g.state.teamOf[player.id] = i % g.state.config.teams;
      });
    },

    start(g) {
      if (g.state.phase !== "lobby" && g.state.phase !== "end") return;
      if (startProblem(g)) return;
      g.state.prompts = pickPrompts(g);
      g.state.round = 0;
      g.state.scores = teamIndexes(g).map(() => 0);
      g.state.cursor = 0;
      beginRound(g);
    },

    /** Move on without waiting: writing -> voting -> results -> next round. */
    next(g) {
      if (g.state.phase === "write") beginVote(g);
      else if (g.state.phase === "vote") tally(g);
      else if (g.state.phase === "result") advance(g);
    },

    /** From the final scores back to the lobby, to change teams or settings. */
    lobby(g) {
      if (g.state.phase === "end") g.state.phase = "lobby";
    },

    exit(g) {
      g.end();
    },
  },

  onPlayer: {
    /** Pick a team. Switching is only possible in the lobby; latecomers can pick at any time. */
    join(g, player, team) {
      if (!Number.isInteger(team) || team < 0 || team >= g.state.config.teams) return;
      if (g.state.phase !== "lobby" && player.id in g.state.teamOf) return;
      g.state.teamOf[player.id] = team;
    },

    /** One answer per team: the first teammate to send it locks it in. */
    answer(g, player, text) {
      const team = g.state.teamOf[player.id];
      if (g.state.phase !== "write" || team === undefined || !g.state.answering.includes(team)) return;
      if (team in g.state.answers || typeof text !== "string") return;
      const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER);
      if (clean === "") return;
      g.state.answers[team] = { text: clean, by: player.name };
      if (g.state.answering.every((entry) => entry in g.state.answers)) beginVote(g);
    },

    /** `index` is a position on the ballot, which hides whose answer is whose. */
    vote(g, player, index) {
      if (g.state.phase !== "vote" || player.id in g.state.votes) return;
      const team = g.state.ballot[index];
      if (team === undefined || !choices(g, player).includes(team)) return;
      g.state.votes[player.id] = team;
      const waiting = g.players.filter((p) => p.connected && choices(g, p).length > 0 && !(p.id in g.state.votes));
      if (waiting.length === 0) tally(g);
    },
  },

  hostView(g) {
    const { phase, config, prompts, round, answering, answers, ballot, votes, winners, teamOf } = g.state;
    const voters = g.players.filter((p) => p.connected && choices(g, p).length > 0);
    return {
      phase,
      round: round + 1,
      total: prompts.length || config.rounds,
      config,
      packs: PACKS.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        count: entry.prompts.length,
      })),
      teams: teamIndexes(g).map((team) => ({
        index: team,
        name: TEAM_NAMES[team],
        score: g.state.scores[team] ?? 0,
        members: members(g, team).map((p) => ({ name: p.name, connected: p.connected })),
        answering: phase === "write" && answering.includes(team),
        submitted: phase === "write" && team in answers,
      })),
      unassigned: g.players.filter((p) => !(p.id in teamOf)).map((p) => p.name),
      problem: startProblem(g),
      prompt: showsPrompt(phase) ? (prompts[round] ?? null) : null,
      ...clock(g),
      // The ballot never says whose answer is whose, so the projector cannot leak it.
      ballot: phase === "vote" ? ballot.map((team) => answers[team].text) : null,
      openVote: phase === "vote" && g.state.openVote,
      votesIn: Object.keys(votes).length,
      voters: voters.length,
      results:
        phase === "result"
          ? answering
              .map((team) => ({
                team,
                name: TEAM_NAMES[team],
                text: answers[team]?.text ?? null,
                by: answers[team]?.by ?? null,
                voters: g.players.filter((p) => votes[p.id] === team).map((p) => p.name),
                won: winners.includes(team),
              }))
              .sort((a, b) => b.voters.length - a.voters.length || a.team - b.team)
          : null,
      unopposed: phase === "result" && ballot.length === 1,
      standings: standings(g),
      champions: phase === "end" ? champions(g) : null,
    };
  },

  playerView(g, player) {
    const { phase, config, prompts, round, answering, answers, ballot, votes, winners, teamOf } = g.state;
    const team: number | undefined = teamOf[player.id];
    const mine = choices(g, player);
    const voted = votes[player.id];
    const board = standings(g);
    return {
      phase,
      round: round + 1,
      total: prompts.length || config.rounds,
      team: team ?? null,
      teamName: team === undefined ? null : TEAM_NAMES[team],
      score: team === undefined ? 0 : (g.state.scores[team] ?? 0),
      canSwitch: phase === "lobby",
      teams: teamIndexes(g).map((index) => ({
        index,
        name: TEAM_NAMES[index],
        members: members(g, index).map((p) => p.name),
      })),
      prompt: showsPrompt(phase) ? (prompts[round] ?? null) : null,
      ...clock(g),
      writing:
        phase === "write"
          ? {
              up: team !== undefined && answering.includes(team),
              // Only the team that wrote it sees an answer before the vote.
              answer: team !== undefined ? (answers[team] ?? null) : null,
              teams: answering.map((entry) => TEAM_NAMES[entry]),
              max: MAX_ANSWER,
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
            }
          : null,
      result:
        phase === "result"
          ? {
              won: team !== undefined && winners.includes(team),
              winners: winners.map((entry) => TEAM_NAMES[entry]),
              answers: answering
                .filter((entry) => entry in answers)
                .map((entry) => ({ name: TEAM_NAMES[entry], text: answers[entry].text })),
            }
          : null,
      end:
        phase === "end"
          ? {
              won: team !== undefined && champions(g).includes(team),
              champions: champions(g).map((entry) => TEAM_NAMES[entry]),
              place: team === undefined ? null : board.filter((entry) => entry.score > (g.state.scores[team] ?? 0)).length + 1,
            }
          : null,
    };
  },
});
