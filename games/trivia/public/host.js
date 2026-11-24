var game = Arcade.connect();
var app = document.getElementById("app");
showStatus(game);

var LETTERS = ["A", "B", "C", "D"];

function scoreboard(view, withGains) {
  return el(
    "ol",
    { class: withGains ? "board compact" : "board" },
    view.players.map(function (p, i) {
      var gain = withGains && view.gained && view.gained[p.id];
      return el(
        "li",
        { class: p.connected ? "" : "away" },
        el("span", { class: "rank" }, i + 1),
        el("span", { class: "name" }, p.name),
        gain ? el("span", { class: "gain" }, "+" + gain) : null,
        el("span", { class: "score" }, p.score),
      );
    }),
  );
}

game.onView(function (view) {
  if (view.phase === "lobby") {
    return mount(
      app,
      el(
        "div",
        { class: "host-lobby", style: "display:grid;gap:28px" },
        el("h1", {}, "Quick Trivia"),
        el("p", { class: "lead" }, view.total + " questions. Right answers score, fast answers score more."),
        el("ul", { class: "chips" }, view.players.map(function (p) { return el("li", {}, p.name); })),
        el(
          "div",
          { class: "row" },
          el("button", { id: "start", disabled: view.players.length === 0, onclick: function () { game.send("start"); } }, "Start"),
          el("button", { class: "quiet", onclick: Arcade.exit }, "Back to arcade"),
          view.players.length === 0 ? el("span", { class: "muted" }, "Waiting for players…") : null,
        ),
      ),
    );
  }

  if (view.phase === "question" || view.phase === "reveal") {
    var revealed = view.phase === "reveal";
    var bar = el("i", {});
    mount(
      app,
      el(
        "div",
        { style: "display:grid;gap:clamp(16px,3vh,36px)" },
        el(
          "div",
          { class: "meta" },
          el("span", {}, "Question " + view.round + " of " + view.total),
          el("span", { id: "answered" }, view.answered + " of " + view.players.length + " answered"),
        ),
        el("p", { class: "question" }, view.question.text),
        el(
          "ul",
          { class: "choices" },
          view.question.choices.map(function (choice, i) {
            var cls = "c" + i + (revealed ? (i === view.correct ? " right" : " wrong") : "");
            return el(
              "li",
              { class: cls },
              el("span", {}, LETTERS[i]),
              el("span", {}, choice),
              revealed ? el("span", { class: "count" }, view.tally[i]) : null,
            );
          }),
        ),
        el("div", { class: "timer" }, bar),
        revealed ? scoreboard(view, true) : null,
        el(
          "div",
          { class: "row" },
          el("button", { id: "next", class: "quiet", onclick: function () { game.send("next"); } }, revealed ? "Next" : "Reveal now"),
        ),
      ),
    );
    if (view.deadline) countdown(game, bar, view.deadline, revealed ? 7000 : 20000);
    return;
  }

  // end
  mount(
    app,
    el(
      "div",
      { style: "display:grid;gap:28px" },
      el("h1", {}, view.players.length ? view.players[0].name + " wins!" : "Game over"),
      scoreboard(view, false),
      el(
        "div",
        { class: "row" },
        el("button", { id: "again", onclick: function () { game.send("start"); } }, "Play again"),
        el("button", { class: "quiet", onclick: function () { game.send("exit"); } }, "Back to arcade"),
      ),
    ),
  );
});
