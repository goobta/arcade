# Punchline

Open mic night for teams. Everyone joins a crew on their phone; each round a
prompt goes up, everybody writes an answer, each crew picks its best one, the
whole room votes, and the answer with the most votes scores a point for its
crew. Rimshot, a talking microphone, emcees.

The crews are food mascots, told apart by shape as well as colour: Hot Sauce,
Blueberries, Lemons, Pickles, Grapes and Tangerines.

The host sets these in the lobby:

| Setting | Choices | Default |
|---|---|---|
| Crews | 2 to 6 | 2 |
| Rounds | 3, 5, 8 or 10 | 5 |
| Questions | every pack in `questions/`, or ✨ AI (see [AI prompts](#ai-prompts)) | first pack by file name |
| ✨ Enhance | how much of a pack's show the AI writes, 0 to 100% (see [AI enhance](#ai-enhance)) | off |

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
smallest crew (all but a [guest of honour](#guest-of-honour), who may watch). Latecomers pick a crew themselves and can write straight away.

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
players, the projector lobby swaps the crew cards for scrolling lanes of names.
Either lobby shows a QR code to join next to the room code.

The fonts (Bagel Fat One and Nunito, plus Baloo 2 for the Raju's 60th
look, all SIL Open Font License) are served from
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
- `theme` is optional and names a look for the whole show (see [Themed packs](#themed-packs)).
  An unknown theme is logged and ignored, and the pack plays on the usual stage.
- `vip` is optional and gives the show a seat for a guest of honour (see
  [Guest of honour](#guest-of-honour)).
- A file that does not parse is skipped, and the reason is logged when the
  game starts. Other packs still load.
- Prompts are drawn at random and are not repeated until the pack runs out,
  including across "Play again".

## Themed packs

A pack can dress the show. While it is the chosen question set, the projector
and every phone switch to its look; pick another pack (or ✨ AI) and the usual
Open Mic Night stage comes back. The look follows the lobby setting live, so
the host sees it change before starting.

```json
{ "name": "Raju's 60th", "theme": "raju60", "prompts": ["..."] }
```

A look has three parts, all under the same key:

- **Crew names** in `THEMES` in [`game.ts`](game.ts), so the server's views and
  messages use them.
- **Art and copy** in `LOOKS` at the end of [`public/ui.js`](public/ui.js):
  mascots, the emcee, decorations, heckle labels, Rimshot's lines and any
  wording to swap. Anything a look leaves out falls back to the usual show.
- **Colours and layout tweaks** under `body[data-look="..."]` at the end of
  [`public/style.css`](public/style.css).

`raju60` ([`questions/raju-60th.json`](questions/raju-60th.json)) is a
wedding-tent night: Indian sweets for crews (Gulab Jamuns, Kulfis, Ladoos,
Barfis, Faloodas, Jalebis), Rimshot ji in a turban, dancers in saris, tablas,
marigold garlands, and "WAH WAH!" in place of "ZING!". Its type is Baloo 2,
served from `public/fonts` like the others and fetched only when the look is
on.

## Guest of honour

A pack can keep one seat for the person the party is for: a birthday, a
leaving do, a holiday host. It is a rule of the pack, separate from its look,
so a plain pack can have one and a themed pack need not.

```json
{ "name": "Raju's 60th", "theme": "raju60", "vip": { "title": "Birthday Boy", "votes": 3 }, "prompts": ["..."] }
```

`title` is what the seat is called (default "Guest of Honour") and `votes` is
what each of their final-ballot votes is worth (1 to 9, default 3).
`"vip": true` takes both defaults. Packs without `vip`, and ✨ AI shows, play
exactly as before.

- **Taking the seat.** While such a pack is chosen, every phone's crew picker
  has an "I'm the Birthday Boy" card. There is one seat, first come first
  served; once it is taken the other phones show who has it. The holder can
  give it back in the lobby ("Not me"), and the host can empty it by clicking
  the seat's pill on the projector. Once the show is running, only a latecomer
  who has no crew yet can take it.
- **Watch, or join a crew.** The guest of honour watches unless they pick a
  crew, and can change their mind until the show starts. Watching, they write
  nothing and nobody waits for them in the crew stage; they get the heckle
  buttons from the first second. On a crew they play like anyone else, and
  their vote among teammates is an ordinary one.
- **The final vote.** They vote like everyone else (any answer they did not
  write; two picks with four or more crews), and each pick counts for `votes`.
  A round's "X of Y votes" then counts votes rather than judges.
- **Always on show.** The projector lists them first among the judges, crowned,
  whether or not they have voted yet, and first among an answer's voters at
  the reveal, with a "×3".
- **Left alone.** Shuffle crews and Balance crews never move them, and a
  watching guest is not drafted onto a crew when the curtain goes up.

A look can reword the seat's lines (`vipWatch`, `vipWelcome`, `vipWatching`,
`vipOpen` in its `text`); the crown is the same in every look.

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

### AI enhance

A pack can be topped up instead of replaced. With the key set, a **✨ Enhance**
pill sits next to the chosen pack in the lobby, and opens two sliders:

- **AI share** is how much of the show the AI writes, from 0% (off, the
  default) to 100% in steps of ten. It is a share of the rounds, rounded, and
  never none while it is above zero: 40% of 5 rounds is 2 AI prompts and 3 of
  the pack's own. At 100% every prompt is new.
- **Spice** is the same slider as above, and applies to what the AI writes.

The AI is shown the whole pack (its name, description and every prompt) and
which of those prompts are playing tonight, and is asked to extend the pack's
theme: new situations and angles in the same world, with the same recurring
people and voice, rather than rewordings or general party prompts. Anything
that repeats one of the pack's own is thrown away.
The two kinds are shuffled together and nothing on screen says which is which.
It is still the pack's show: its look and its guest-of-honour seat stay. The
wait, the failure message and **Encore** work as they do for a full AI show.

The key reaches the game through the hub: `game.json` lists it under `"env"`,
which is the only way a game sees any of the hub's environment. The theme is
typed by the host and is sent to the model as data, not as instructions. The
generator is in [`ai.ts`](ai.ts); it is only loaded when AI prompts are used
or mixed in.

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
