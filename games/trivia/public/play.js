var game = Arcade.connect();
var app = document.getElementById("app");
showStatus(game);

var LETTERS = ["A", "B", "C", "D"];

function frame(view, body) {
  return el(
    "div",
    { style: "display:contents" },
    el(
      "div",
      { class: "top" },
      el("span", {}, view.phase === "lobby" ? "Quick Trivia" : "Question " + Math.min(view.round, view.total) + " of " + view.total),
      el("span", { class: "score" }, view.score + " pts"),
    ),
    body,
  );
}

function center() {
  return el.apply(null, ["div", { class: "center" }].concat([].slice.call(arguments)));
}

game.onView(function (view) {
  if (view.phase === "lobby") {
    return mount(app, frame(view, center(el("p", { class: "big" }, "You're in!"), el("p", { class: "muted" }, "Waiting for the host to start."))));
  }

  if (view.phase === "question") {
    if (!view.choices) {
      return mount(app, frame(view, center(el("p", { class: "big" }, "Get ready…"))));
    }
    return mount(
      app,
      frame(
        view,
        el(
          "div",
          { class: "pad" },
          view.choices.map(function (choice, i) {
            var cls = "c" + i;
            if (view.picked !== null) cls += i === view.picked ? " picked" : " dim";
            return el(
              "button",
              {
                class: cls,
                disabled: view.picked !== null,
                "data-choice": i,
                onclick: function () {
                  game.send("answer", i);
                },
              },
              LETTERS[i] + ". " + choice,
            );
          }),
        ),
      ),
    );
  }

  if (view.phase === "reveal") {
    var right = view.picked !== null && view.picked === view.correct;
    return mount(
      app,
      frame(
        view,
        center(
          el("p", { class: "big " + (right ? "good" : "bad"), id: "result" },
            view.picked === null ? "Too slow!" : right ? "Correct!" : "Not quite"),
          el("p", { class: "muted" }, right ? "+" + view.gained + " points" : "Answer: " + LETTERS[view.correct] + ". " + view.choices[view.correct]),
        ),
      ),
    );
  }

  mount(
    app,
    frame(
      view,
      center(
        el("p", { class: "big", id: "place" }, view.place === 1 ? "You won!" : "You placed " + view.place + " of " + view.players),
        el("p", { class: "muted" }, view.score + " points"),
      ),
    ),
  );
});
