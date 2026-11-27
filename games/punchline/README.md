# Punchline

A team party game. Everyone joins a team on their phone; each round a prompt
goes up, the teams whose turn it is write one answer each, everyone votes, and
the answer with the most votes scores a point for its team.

The host sets these in the lobby:

| Setting | Choices | Default |
|---|---|---|
| Teams | 2, 3 or 4 | 2 |
| Answering each round | 2, 3 or all teams | 2 |
| Rounds | 3, 5, 8 or 10 | 5 |
| Questions | every pack in `questions/` | first by file name |

Rules worth knowing:

- **One answer per team.** The first teammate to send one locks it in.
- **Teams take turns answering**, in order, so each answers equally often.
- **Nobody votes for their own team's answer.** When only two answers are up,
  the two teams that wrote them sit the vote out and the other teams decide.
  The exception is a game where no neutral voter exists (two teams, both
  answering): then everyone votes on both answers, own team included.
- **Ties** score for every tied team. A round with no votes scores for nobody,
  and a team that is the only one to answer scores unopposed.

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
