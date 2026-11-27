# Punchline

Open mic night for teams. Everyone joins a crew on their phone; each round a
prompt goes up, the crews whose turn it is write one answer each, everyone
votes, and the answer with the most votes scores a point for its crew. Rimshot,
a talking microphone, emcees.

The crews are food mascots, told apart by shape as well as colour: Hot Sauce,
Blueberries, Lemons, Pickles, Grapes, Tangerines, Mints and Marshmallows.

The host sets these in the lobby:

| Setting | Choices | Default |
|---|---|---|
| Crews | 2 to 8 | 2 |
| Answering each round | 2, 3, ... or all crews | 2 |
| Rounds | 3, 5, 8 or 10 | 5 |
| Questions | every pack in `questions/` | first by file name |

Rules worth knowing:

- **One answer per crew.** The first teammate to send one locks it in.
- **Crews take turns answering**, in order, so each answers equally often.
- **Nobody votes for their own crew's answer.** When only two answers are up,
  the two crews that wrote them sit the vote out and the other crews decide.
  The exception is a game where no neutral voter exists (two crews, both
  answering): then everyone votes on both answers, own crew included.
- **Ties** score for every tied crew. A round with no votes scores for nobody,
  and a crew that is the only one to answer scores unopposed.
- **Stragglers** who have not picked a crew when the show starts join the
  smallest crew. Latecomers pick a crew themselves and join from the next answer.

While the show runs:

- **Heckles.** Phones whose crew is not writing this round get six reaction
  buttons (HA!, OOF, WOW, \*clap\*, BOO, zzz). Each tap floats up the projector
  with the heckler's name. A phone can heckle once a second, and at most eight
  heckles a second reach the projector however big the room is.
- **Typing.** Writers see which teammates are typing or have an idea, and the
  projector shows it under each crew. Nobody sees the words until the vote.
- **Awards** at the final bows: the Biggest zinger (the answer with the most
  votes in one round), the Crickets award (whoever wrote the most answers that
  got no votes in a round where others did) and the Loudest heckler. An award
  nobody earned is left out.

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

## Tests

The rules are in [`game.ts`](game.ts), apart from the SDK wiring in `server.ts`, so
[`test/game.test.ts`](test/game.test.ts) can drive them directly; `npm test` runs it
with the rest. The end-to-end test in `e2e/` plays a whole show in a browser.
