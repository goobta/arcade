# Arcade

A self-hosted party-game hub: put one screen on a projector, and everyone joins
from their phone with a four-letter code. Games are folders in `games/`.

- **Join once, play many.** The room code belongs to the party, not to a game.
  Players stay connected while the host switches games.
- **Games cost nothing until opened.** Each game is its own process, started
  when the host opens it and stopped when it is closed, has had no players for
  15 minutes, or has run for 4 hours. Only the small hub is always on.
- **Adding a game never touches the hub.** Drop a folder with a `game.json`
  into `games/` and it appears in the picker.

```
phone ─┐                              ┌─ games/trivia   (a process, only while open)
       ├── reverse proxy ── hub ──────┤
host  ─┘                 (always on)  └─ games/buzzer   (not running)
```

## Run it

Needs Node 22.18 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:3000/host> on the big screen and enter the PIN
(`letmein` in dev, or whatever `ARCADE_HOST_PIN` is set to). Open the address
shown there on a phone, or in another browser window, and join with the code.

To try it from real phones on your network, tell the hub its address so the
join link and QR code point somewhere they can reach:

```bash
PUBLIC_URL=http://192.168.1.20:3000 npm run dev
```

## Write a game

```bash
npm run games -- new my-game "My Game"
```

That copies [`templates/game`](templates/game) to `games/my-game`. Restart
nothing: go back to the picker on `/host` and it is there. Each launch starts a
fresh process, so edit, close the game, and open it again to see changes.

A game is four things:

```
games/my-game/
  game.json          what the picker shows, and how to start the game
  server.ts          state, handlers, views
  public/host.html   the projector page   (+ host.js)
  public/play.html   the phone page       (+ play.js)
```

### server.ts

```ts
import { serve } from "@arcade/sdk";

interface State {
  phase: "waiting" | "open" | "won";
  winner: string | null;
  scores: Record<string, number>;
}

serve<State>({
  init: () => ({ phase: "waiting", winner: null, scores: {} }),

  onHost: {
    open(g) {
      g.state.phase = "open";
      g.timer("round", 10_000, () => { g.state.phase = "waiting"; });
    },
  },

  onPlayer: {
    buzz(g, player) {
      if (g.state.phase !== "open") return;
      g.clearTimer("round");
      g.state.phase = "won";
      g.state.winner = player.id;
      g.state.scores[player.id] = (g.state.scores[player.id] ?? 0) + 1;
    },
  },

  hostView: (g) => ({ phase: g.state.phase, players: g.players }),
  playerView: (g, player) => ({ phase: g.state.phase, youWon: g.state.winner === player.id }),
});
```

- **State** is plain data you own.
- **Handlers** (`onHost`, `onPlayer`, timers) are the only places it changes.
- **Views** say what each screen shows. After every handler or timer the SDK
  recomputes them and sends each screen its own, only if it changed. There is
  no "send update" code to write, and `playerView` is private to that player,
  so a hand of cards or a secret answer is safe there.

Inside a handler, `g` gives you:

| | |
|---|---|
| `g.state` | your state |
| `g.players` | everyone who joined, in order: `{ id, name, connected }` |
| `g.timer(name, ms, fn)` / `g.clearTimer(name)` | one-shot timers |
| `g.deadline(name)` | when a timer fires (epoch ms), for countdowns |
| `g.send(player \| "host", type, data)` / `g.broadcast(type, data)` | one-off events, e.g. a sound cue |
| `g.end()` | close the game and return everyone to the picker |
| `g.sync()` | push views after changing state outside a handler (rarely needed) |

Optional hooks: `onJoin(g, player)` the first time a player arrives (late
joiners included), and `onLeave(g, player)` when a connection drops. A player
whose phone sleeps or reloads comes back to the same seat: `player.id` is
stable for the whole party.

### host.js and play.js

```html
<script src="./_sdk/arcade.js"></script>
<script src="./play.js"></script>
```

```js
const game = Arcade.connect();

game.onView((view) => render(view));          // every time your view changes
button.onclick = () => game.send("buzz");     // runs onPlayer.buzz on the server
```

| | |
|---|---|
| `game.onView(fn)` | called with the latest `hostView` / `playerView` |
| `game.send(type, data)` | call the handler of that name |
| `game.on(type, fn)` | receive `g.send` / `g.broadcast` events |
| `game.onStatus(fn)` | `connecting`, `connected`, `reconnecting`, `replaced`, `closed` |
| `game.now()` | server time in ms, to count down to a `deadline` |
| `game.me`, `game.role`, `game.code` | who this screen is |
| `Arcade.exit()` | host page only: close the game |

Use relative URLs (`./style.css`, never `/style.css`): the hub serves each
launch under its own path.

### game.json

```json
{
  "manifest": 1,
  "id": "my-game",
  "name": "My Game",
  "blurb": "One line for the picker.",
  "minPlayers": 2,
  "maxPlayers": 12,
  "start": ["node", "server.ts"],
  "thumbnail": "public/thumb.svg"
}
```

`manifest`, `id`, `name` and `start` are required. `id` must equal the folder
name. A folder whose name starts with `_` or `.`, or with `"enabled": false`,
is skipped. A game.json with a mistake is skipped too, and the hub logs why at
startup.

A game that needs npm packages beyond the SDK lists them in its own
`package.json` and commits its own `package-lock.json`; the Docker build
installs it in place.

### Games in their own repositories

A game can live in its own repo and be mounted as a git submodule:

```bash
npm run games -- add https://github.com/you/arcade-game-charades
```

```bash
npm run games -- list
```

`list` shows every installed game and where it comes from.

### Games not written with the SDK

The hub only requires a process that:

1. listens on `$HOST:$PORT` and answers `GET /healthz` with 200 once ready;
2. serves `GET /host` and `GET /play` (the paths are configurable in game.json);
3. verifies the ticket in the page's URL fragment (`#t=…`), an HMAC-SHA256
   signed with `$ARCADE_SECRET` (see [`packages/sdk/src/ticket.ts`](packages/sdk/src/ticket.ts));
4. exits on SIGTERM.

It receives `ARCADE_CODE`, `ARCADE_LAUNCH_ID`, `ARCADE_GAME_ID`,
`ARCADE_MAX_PLAYERS`, `ARCADE_PUBLIC_URL` and `BASE_PATH`. Requests arrive with
`BASE_PATH` already stripped.

## Configuration

Environment variables for the hub:

| Variable | Default | |
|---|---|---|
| `ARCADE_HOST_PIN` | (required) | PIN for `/host`, at least 6 characters |
| `PUBLIC_URL` | `http://localhost:3000` | Address players are sent to; also used for the QR code |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the hub listens |
| `ARCADE_MAX_GAMES` | `1` | Game processes allowed at once |
| `ARCADE_IDLE_MINUTES` | `15` | Stop a game with no players connected for this long |
| `ARCADE_MAX_GAME_HOURS` | `4` | Stop a game after this long regardless |
| `ARCADE_GAME_HEAP_MB` | `96` | Memory cap for each game's JavaScript heap |
| `ARCADE_MAX_PLAYERS` | `16` | Players per party |
| `ARCADE_MAX_SESSIONS` | `4` | Parties open at once |
| `ARCADE_GAMES_DIR` | `./games` | Where games are found |

## How it fits together

| Path | |
|---|---|
| `packages/hub` | The always-on server: pages, PIN, lobby websocket, process runner, proxy |
| `packages/sdk` | What games import: `serve()` on Colyseus, and the browser client |
| `games/` | The games |
| `templates/game` | Starting point for a new game |
| `e2e/` | A browser test that plays a whole party |

- The hub gives each phone a player id and remembers it on the phone. When a
  game starts, the hub hands every screen a signed ticket; the game trusts the
  ticket, not the browser, for who is who and who is the host.
- Game traffic goes through the hub at `/g/<launch id>/…`. The id is random per
  launch, so a tab left open from an earlier game cannot reach the next one.
- A game process is given a fresh environment, so the host PIN and the hub's
  other settings never reach game code. Games are otherwise trusted: they run
  as the same user as the hub.
- Parties live in memory. Restarting the hub ends them.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run typecheck
```

The end-to-end test needs Chromium for Playwright
(`npx playwright install chromium`, once).

## Deploy

The [Dockerfile](Dockerfile) builds the hub and every game into one image.
Run it with `ARCADE_HOST_PIN` and `PUBLIC_URL` set, behind a reverse proxy
that forwards websockets and sets `X-Real-IP` (the rate limits use it). It
needs no volumes and no writable filesystem apart from `/tmp`, and should be
run with an init process (`docker run --init`, or `init: true` in Compose) so
stopped games are reaped.

Measured with eight players in one game: about 30 MB for the idle hub and
about 70 MB while a game is running.
