// A complete game in one file: the host opens the buzzers, the first phone to
// buzz wins the round. Copy this folder (npm run games -- new <id>) and edit.
//
// The shape of every game:
//   state     - plain data you own
//   handlers  - the only places state changes (onHost, onPlayer, timers)
//   views     - what the projector and each phone are shown
// After every handler or timer the SDK recomputes the views and sends each
// screen its own, so there is no "send update" code to write.
import { serve } from "@arcade/sdk";

interface State {
  phase: "waiting" | "open" | "won";
  winner: string | null; // player id
  scores: Record<string, number>;
}

const OPEN_MS = 10_000;

serve<State>({
  init: () => ({ phase: "waiting", winner: null, scores: {} }),

  // Sent from host.js with game.send("open").
  onHost: {
    open(g) {
      g.state.phase = "open";
      g.state.winner = null;
      // Nobody buzzed in time: close the round.
      g.timer("round", OPEN_MS, () => {
        g.state.phase = "waiting";
      });
    },
    exit(g) {
      g.end(); // back to the arcade's game picker
    },
  },

  // Sent from play.js with game.send("buzz").
  onPlayer: {
    buzz(g, player) {
      if (g.state.phase !== "open") return; // too early or too late
      g.clearTimer("round");
      g.state.phase = "won";
      g.state.winner = player.id;
      g.state.scores[player.id] = (g.state.scores[player.id] ?? 0) + 1;
    },
  },

  // The projector. Everyone in the room can see this.
  hostView: (g) => ({
    phase: g.state.phase,
    deadline: g.deadline("round") ?? null,
    winner: g.players.find((p) => p.id === g.state.winner)?.name ?? null,
    players: g.players.map((p) => ({
      name: p.name,
      connected: p.connected,
      score: g.state.scores[p.id] ?? 0,
    })),
  }),

  // One phone. Only that player receives it, so secrets are safe here.
  playerView: (g, player) => ({
    phase: g.state.phase,
    youWon: g.state.winner === player.id,
    score: g.state.scores[player.id] ?? 0,
  }),
});
