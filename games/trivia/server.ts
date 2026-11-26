// Quick Trivia: the reference game. Everything the players see comes from the
// two view functions at the bottom; everything they can do is a handler.
import { serve, type Game } from "@arcade/sdk";
import allQuestions from "./questions.json" with { type: "json" };

interface Question {
  text: string;
  choices: string[];
  correct: number;
}

interface State {
  phase: "lobby" | "question" | "reveal" | "end";
  questions: Question[];
  round: number;
  /** Player id -> chosen index and when, for the current question. */
  answers: Record<string, { choice: number; at: number }>;
  askedAt: number;
  scores: Record<string, number>;
  /** Points each player earned on the question just revealed. */
  gained: Record<string, number>;
}

const ROUNDS = 8;
const QUESTION_MS = 20_000;
const REVEAL_MS = 7_000;

function pickQuestions(): Question[] {
  const pool = [...(allQuestions as Question[])];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, ROUNDS);
}

const current = (g: Game<State>): Question | undefined => g.state.questions[g.state.round];

function ask(g: Game<State>): void {
  g.state.phase = "question";
  g.state.answers = {};
  g.state.gained = {};
  g.state.askedAt = Date.now();
  g.timer("question", QUESTION_MS, () => reveal(g));
}

function reveal(g: Game<State>): void {
  g.clearTimer("question");
  const question = current(g);
  if (!question) return;
  for (const [id, answer] of Object.entries(g.state.answers)) {
    if (answer.choice !== question.correct) continue;
    // 500 for being right, up to 500 more for being quick.
    const speed = Math.max(0, 1 - (answer.at - g.state.askedAt) / QUESTION_MS);
    const points = 500 + Math.round(500 * speed);
    g.state.gained[id] = points;
    g.state.scores[id] = (g.state.scores[id] ?? 0) + points;
  }
  g.state.phase = "reveal";
  g.timer("reveal", REVEAL_MS, () => advance(g));
}

function advance(g: Game<State>): void {
  g.clearTimer("reveal");
  g.state.round += 1;
  if (g.state.round < g.state.questions.length) ask(g);
  else g.state.phase = "end";
}

function ranking(g: Game<State>) {
  return g.players
    .map((p) => ({ id: p.id, name: p.name, connected: p.connected, score: g.state.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

serve<State>({
  init: () => ({
    phase: "lobby",
    questions: [],
    round: 0,
    answers: {},
    askedAt: 0,
    scores: {},
    gained: {},
  }),

  onHost: {
    start(g) {
      if (g.state.phase !== "lobby" && g.state.phase !== "end") return;
      if (g.players.length === 0) return;
      g.state.questions = pickQuestions();
      g.state.round = 0;
      g.state.scores = {};
      ask(g);
    },
    next(g) {
      if (g.state.phase === "question") reveal(g);
      else if (g.state.phase === "reveal") advance(g);
    },
    exit(g) {
      g.end();
    },
  },

  onPlayer: {
    answer(g, player, choice) {
      const question = current(g);
      if (g.state.phase !== "question" || !question) return;
      if (player.id in g.state.answers) return; // first answer stands
      if (!Number.isInteger(choice) || choice < 0 || choice >= question.choices.length) return;
      g.state.answers[player.id] = { choice, at: Date.now() };
      const waiting = g.players.filter((p) => p.connected && !(p.id in g.state.answers));
      if (waiting.length === 0) reveal(g);
    },
  },

  hostView(g) {
    const { phase, round, questions, answers, gained } = g.state;
    const question = current(g);
    const showing = phase === "question" || phase === "reveal";
    return {
      phase,
      round: round + 1,
      total: questions.length || ROUNDS,
      players: ranking(g),
      question: showing && question ? { text: question.text, choices: question.choices } : null,
      deadline: g.deadline(phase === "question" ? "question" : "reveal") ?? null,
      answered: Object.keys(answers).length,
      // Never sent while the question is open, so the projector cannot leak it.
      correct: phase === "reveal" && question ? question.correct : null,
      tally:
        phase === "reveal" && question
          ? question.choices.map((_, i) => Object.values(answers).filter((a) => a.choice === i).length)
          : null,
      gained: phase === "reveal" ? gained : null,
    };
  },

  playerView(g, player) {
    const { phase, round, questions, answers, scores, gained } = g.state;
    const question = current(g);
    const mine = answers[player.id];
    const board = ranking(g);
    return {
      phase,
      round: round + 1,
      total: questions.length || ROUNDS,
      score: scores[player.id] ?? 0,
      choices: phase === "question" || phase === "reveal" ? (question?.choices ?? null) : null,
      picked: mine ? mine.choice : null,
      deadline: phase === "question" ? (g.deadline("question") ?? null) : null,
      correct: phase === "reveal" && question ? question.correct : null,
      gained: phase === "reveal" ? (gained[player.id] ?? 0) : null,
      place: phase === "end" ? board.findIndex((p) => p.id === player.id) + 1 : null,
      players: board.length,
    };
  },
});
