# Punchline

Open mic night for teams. Everyone joins a crew on their phone; each round a
prompt goes up, everybody writes an answer, each crew picks its best one, the
whole room votes, and the answer with the most votes scores a point for its
crew. Rimshot, a talking microphone, emcees.

The crews are food mascots, told apart by shape as well as colour: Hot Sauce,
Blueberries, Lemons, Pickles, Grapes, Tangerines, Mints and Marshmallows.

The host sets these in the lobby:

| Setting | Choices | Default |
|---|---|---|
| Crews | 2 to 8 | 2 |
| Rounds | 3, 5, 8 or 10 | 5 |
| Questions | every pack in `questions/`, or ✨ AI (see [AI prompts](#ai-prompts)) | first pack by file name |

Every round has two stages, and every crew plays both.

**1. Crew stage, 30 seconds, on the phones.** One clock for the whole room.

- For the first 25 seconds you write your own answer and lock it in. One
  answer each, and a locked answer cannot be changed.
- Your teammates' answers appear on your phone the moment they lock them (never
  while they are still typing). Other crews and the projector see none of it:
  the projector shows only how many answers each crew has locked.
- Once your own answer is locked you can vote for a teammate's, and change that
  vote until the clock ends. You cannot vote for your own.
- The last 5 seconds are for voting only. Anyone who did not lock an answer in
  time can still vote.
- Each crew publishes its answer with the most teammate votes. On a tie the one
  locked first wins. A player on a crew by themselves publishes their own. A
  crew that locked nothing sits the round out.
- The stage ends early once everyone connected has locked an answer and voted
  (or has nobody to vote for).

**2. Final vote, 20 seconds.** Every crew's published answer goes up, without
names.

- You can vote for any answer **you did not write yourself**, your own crew's
  included.
- With 2 or 3 crews you get **1 vote**. With 4 or more you get **2 votes**,
  which must go to two different answers.
- Tap an answer to pick it and tap it again to take the vote back. With all
  your votes used, tapping another answer replaces your oldest pick.
- Voting ends when the clock runs out or everyone has used all their votes.
- The answer with the most votes scores a point for its crew. **Ties** score
  for every tied crew, a round with no votes scores for nobody, and a crew that
  is the only one to publish scores unopposed.

**Stragglers** who have not picked a crew when the show starts join the
smallest crew. Latecomers pick a crew themselves and can write straight away.

While the show runs:

- **Heckles.** Once your answer is locked you get six reaction buttons (HA!,
  OOF, WOW, \*clap\*, BOO, zzz) until the final vote opens. Each tap floats up
  the projector with the heckler's name. A phone can heckle once a second, and
  at most eight heckles a second reach the projector however big the room is.
- **Typing.** You see which teammates are typing or have an idea, and the
  projector shows it under each crew. Nobody sees the words until they are
  locked.
- **Awards** at the final bows: the Biggest zinger (the answer with the most
  votes in one round), the Crickets award (whoever wrote the most published
  answers that got no votes in a round where others did) and the Loudest
  heckler. An award nobody earned is left out.

In the lobby, **Shuffle crews** deals everyone out again at random, and
**Balance crews** evens the crews out by moving as few people as possible (the
latest arrivals on the biggest crew), placing anyone who has not picked yet.
Phones that have disconnected are not counted or moved.

Big rooms are welcome: up to 100 players (the hub's `ARCADE_MAX_PLAYERS` also
caps a party, and defaults to 16). With more than four crews or more than 16
players, the projector lobby swaps the crew cards for scrolling lanes of names,
with a QR code to join.

The fonts (Bagel Fat One and Nunito, SIL Open Font License) are served from
`public/fonts`, so the game needs no internet connection.

## Question packs

Each `.json` file in [`questions/`](questions) is a pack. Add, edit or delete
files there and the lobby offers whatever it finds the next time the game is
opened; no code changes.

```json
{
  "name": "Party Starter",
  "description": "All-purpose prompts for any crowd.",
  "prompts": [
    "The worst thing to say on a first date",
    "A terrible name for a cruise ship"
  ]
}
```

- `prompts` is required: a list of strings of at most 200 characters each.
- `name` (shown in the lobby) defaults to the file name; `description` is optional.
- A file that does not parse is skipped, and the reason is logged when the
  game starts. Other packs still load.
- Prompts are drawn at random and are not repeated until the pack runs out,
  including across "Play again".

## AI prompts

With an `ANTHROPIC_API_KEY`, the Questions setting gains a **✨ AI** choice:
Claude (`claude-sonnet-5-5`) writes that show's prompts. Without the key the
choice is simply not offered, and the game works as before.

- **Theme** is free text, up to 200 characters ("the office party", "camping").
  Leave it empty for a general party.
- **Spice** is a five-step slider:

  | Level | What to expect |
  |---|---|
  | Unc | Wholesome and corny, dad-joke energy, grandparent-safe |
  | Clean | Office-safe (the default) |
  | Cheeky | Mild innuendo, light roasting |
  | Spicy | Adult themes: swearing, dating, drinking |
  | NSFW | Raunchy adult humour for consenting friends |

  Nothing at any level is hateful or aimed at real private people. Claude may
  tone down the very top end, so NSFW means crude, not explicit.
- When the host starts the show, the projector and phones show "Writing your
  prompts" for a few seconds. If the request fails (a bad key, no network, a
  theme the model declines), the game returns to the lobby and Rimshot says
  why. **Cancel** on that screen also returns to the lobby.
- **Encore** writes a new set with the same theme and level, and tells the
  model which prompts this room has already played.

The key reaches the game through the hub: `game.json` lists it under `"env"`,
which is the only way a game sees any of the hub's environment. The theme is
typed by the host and is sent to the model as data, not as instructions. The
generator is in [`ai.ts`](ai.ts); it is only loaded when AI prompts are used.

Local development needs the game's own packages once:

```bash
cd games/punchline && npm install
```

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

## Tests

The rules are in [`game.ts`](game.ts), apart from the SDK wiring in `server.ts`, so
[`test/game.test.ts`](test/game.test.ts) can drive them directly, and
[`test/ai.test.ts`](test/ai.test.ts) checks the prompt writer against a stand-in
for the network. `npm test` runs both with the rest. The end-to-end test in
`e2e/` plays whole shows in a browser (packs only: it never calls the API).
