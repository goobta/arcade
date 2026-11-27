var game = Arcade.connect();
var app = document.getElementById("app");
showStatus(game);

var LETTERS = ["A", "B", "C", "D"];

function configure(change) {
  return function () {
    game.send("configure", change);
  };
}

// One row of the lobby settings: a label and a set of buttons, one of them on.
function setting(label, key, options, current) {
  return el(
    "div",
    { class: "setting" },
    el("span", { class: "label" }, label),
    el(
      "div",
      { class: "seg" },
      options.map(function (option) {
        var change = {};
        change[key] = option.value;
        return el(
          "button",
          {
            class: option.value === current ? "on" : "",
            title: option.title || null,
            "data-set": key + "=" + option.value,
            onclick: configure(change),
          },
          option.text,
        );
      }),
    ),
  );
}

function answeringOptions(teams) {
  var options = [];
  for (var n = 2; n < teams; n++) options.push({ value: n, text: n + " teams" });
  options.push({ value: "all", text: "All teams" });
  return options;
}

function teamCard(team, extra) {
  return el(
    "div",
    { class: "team t" + team.index, "data-team": team.index },
    el("h2", {}, team.name),
    el(
      "ul",
      { class: "members" },
      team.members.length
        ? team.members.map(function (m) { return el("li", { class: m.connected ? "" : "away" }, m.name); })
        : el("li", { class: "empty" }, "Nobody yet"),
    ),
    extra || null,
  );
}

function scoreboard(view) {
  return el(
    "ol",
    { class: "board" },
    view.standings.map(function (entry) {
      return el(
        "li",
        { class: "t" + entry.team },
        el("span", { class: "dot" }),
        el("span", { class: "name" }, entry.name),
        el("span", { class: "score" }, entry.score),
      );
    }),
  );
}

function header(view, right) {
  return el(
    "div",
    { class: "meta" },
    el("span", {}, "Round " + view.round + " of " + view.total),
    el("span", { id: "progress" }, right),
  );
}

function timer(view) {
  var bar = el("i", {});
  var node = el("div", { class: "timer" }, bar);
  if (view.deadline) setTimeout(function () { countdown(game, bar, view.deadline, view.duration); }, 0);
  return node;
}

function list(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function lobby(view) {
  var config = view.config;
  // "2 teams" answering is the same thing as "all" when there are only two.
  var answering = config.answering !== "all" && config.answering >= config.teams ? "all" : config.answering;
  return el(
    "div",
    { class: "stack" },
    el("h1", {}, "Punchline"),
    el("p", { class: "lead" }, "Pick a team on your phone. Teams write the funniest answer, everyone votes."),
    el(
      "div",
      { class: "settings" },
      setting("Teams", "teams", [2, 3, 4].map(function (n) { return { value: n, text: n }; }), config.teams),
      setting("Answering each round", "answering", answeringOptions(config.teams), answering),
      setting("Rounds", "rounds", [3, 5, 8, 10].map(function (n) { return { value: n, text: n }; }), config.rounds),
      view.packs.length
        ? setting(
            "Questions",
            "pack",
            view.packs.map(function (pack) {
              return { value: pack.id, text: pack.name + " (" + pack.count + ")", title: pack.description };
            }),
            config.pack,
          )
        : null,
    ),
    el("div", { class: "teams n" + view.teams.length }, view.teams.map(function (team) { return teamCard(team); })),
    view.unassigned.length
      ? el("p", { class: "muted", id: "unassigned" }, "Still choosing: " + view.unassigned.join(", "))
      : null,
    el(
      "div",
      { class: "row" },
      el("button", { id: "start", disabled: !!view.problem, onclick: function () { game.send("start"); } }, "Start"),
      el("button", { id: "shuffle", class: "quiet", onclick: function () { game.send("shuffle"); } }, "Shuffle teams"),
      el("button", { class: "quiet", onclick: Arcade.exit }, "Back to arcade"),
      view.problem ? el("span", { class: "muted" }, view.problem) : null,
    ),
  );
}

function write(view) {
  var up = view.teams.filter(function (team) { return team.answering; });
  var done = up.filter(function (team) { return team.submitted; }).length;
  return el(
    "div",
    { class: "stack" },
    header(view, done + " of " + up.length + " answers in"),
    el("p", { class: "prompt" }, view.prompt),
    el(
      "div",
      { class: "teams n" + up.length },
      up.map(function (team) {
        return teamCard(
          team,
          el("p", { class: "state" + (team.submitted ? " done" : "") }, team.submitted ? "Answer in!" : "Writing…"),
        );
      }),
    ),
    up.length < view.teams.length ? el("p", { class: "muted" }, "Everyone else: get ready to vote.") : null,
    timer(view),
    el("div", { class: "row" }, el("button", { id: "next", class: "quiet", onclick: function () { game.send("next"); } }, "Skip to voting")),
  );
}

function vote(view) {
  return el(
    "div",
    { class: "stack" },
    header(view, view.votesIn + " of " + view.voters + " votes in"),
    el("p", { class: "prompt" }, view.prompt),
    el(
      "ul",
      { class: "answers" },
      view.ballot.map(function (text, i) {
        return el("li", {}, el("span", { class: "letter" }, LETTERS[i]), el("span", { class: "text" }, text));
      }),
    ),
    el(
      "p",
      { class: "muted" },
      view.openVote ? "Everyone votes. Be honest: pick the best one, even if it isn't yours." : "Vote on your phone for the best answer.",
    ),
    timer(view),
    el("div", { class: "row" }, el("button", { id: "next", class: "quiet", onclick: function () { game.send("next"); } }, "Show results")),
  );
}

function result(view) {
  var winners = view.results.filter(function (entry) { return entry.won; }).map(function (entry) { return entry.name; });
  var last = view.round >= view.total;
  var headline = !winners.length
    ? "Nobody scores"
    : view.unopposed
      ? winners[0] + " scores unopposed"
      : winners.length > 1
        ? "A tie: " + list(winners) + " each score"
        : winners[0] + " takes the round";
  return el(
    "div",
    { class: "stack" },
    header(view, headline),
    el("p", { class: "prompt small" }, view.prompt),
    el(
      "ul",
      { class: "answers revealed" },
      view.results.map(function (entry) {
        return el(
          "li",
          { class: "t" + entry.team + (entry.won ? " won" : ""), "data-team": entry.team },
          el(
            "div",
            { class: "body" },
            el("span", { class: "who" }, entry.name + (entry.by ? " · " + entry.by : "")),
            el("span", { class: "text" + (entry.text ? "" : " none") }, entry.text || "No answer"),
            entry.voters.length ? el("span", { class: "voters" }, entry.voters.join(", ")) : null,
          ),
          el("span", { class: "count" }, entry.voters.length),
        );
      }),
    ),
    scoreboard(view),
    el("div", { class: "row" }, el("button", { id: "next", onclick: function () { game.send("next"); } }, last ? "Final scores" : "Next round")),
  );
}

function end(view) {
  var names = view.champions.map(function (team) { return view.teams[team].name; });
  return el(
    "div",
    { class: "stack" },
    el("h1", { id: "winner" }, names.length > 1 ? "It's a draw: " + list(names) + "!" : names[0] + " team wins!"),
    scoreboard(view),
    el(
      "div",
      { class: "row" },
      el("button", { id: "again", onclick: function () { game.send("start"); } }, "Play again"),
      el("button", { class: "quiet", onclick: function () { game.send("lobby"); } }, "Change teams"),
      el("button", { class: "quiet", onclick: function () { game.send("exit"); } }, "Back to arcade"),
    ),
  );
}

var SCREENS = { lobby: lobby, write: write, vote: vote, result: result, end: end };

game.onView(function (view) {
  mount(app, SCREENS[view.phase](view));
});
