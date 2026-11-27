var game = Arcade.connect();
var app = document.getElementById("app");
showStatus(game);

// What the player has typed so far. The page is redrawn whenever the view
// changes (a teammate joining, say), and that must not eat a half-written answer.
var draft = { round: 0, text: "" };

function list(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function frame(view, body) {
  return el(
    "div",
    { style: "display:contents" },
    el(
      "div",
      { class: "top" },
      el("span", { class: view.team === null ? "" : "tag t" + view.team, id: "team" }, view.team === null ? "Punchline" : view.teamName + " team"),
      view.phase === "lobby" ? null : el("span", {}, "Round " + Math.min(view.round, view.total) + " of " + view.total),
      view.team === null ? null : el("span", { class: "score" }, view.score + (view.score === 1 ? " pt" : " pts")),
    ),
    body,
  );
}

function center() {
  return el.apply(null, ["div", { class: "center" }].concat([].slice.call(arguments)));
}

function teamPicker(view, heading) {
  return el(
    "div",
    { class: "picker" },
    el("p", { class: "big" }, heading),
    view.teams.map(function (team) {
      return el(
        "button",
        {
          class: "t" + team.index + (team.index === view.team ? " picked" : ""),
          "data-team": team.index,
          onclick: function () { game.send("join", team.index); },
        },
        el("span", { class: "name" }, team.name + (team.index === view.team ? " ✓" : "")),
        el("span", { class: "who" }, team.members.length ? team.members.join(", ") : "Nobody yet"),
      );
    }),
    view.team === null ? null : el("p", { class: "muted" }, "Waiting for the host to start."),
  );
}

function timer(view) {
  var bar = el("i", {});
  var node = el("div", { class: "timer" }, bar);
  if (view.deadline) setTimeout(function () { countdown(game, bar, view.deadline, view.duration); }, 0);
  return node;
}

function write(view) {
  var w = view.writing;
  if (!w.up) {
    return center(
      el("p", { class: "big" }, "Sit tight"),
      el("p", { class: "muted", id: "waiting" }, list(w.teams) + " are writing. You vote next."),
    );
  }
  if (w.answer) {
    return center(
      el("p", { class: "muted" }, view.prompt),
      el("p", { class: "big", id: "sent" }, "“" + w.answer.text + "”"),
      el("p", { class: "muted" }, "Sent by " + w.answer.by + ". Waiting for the other team."),
    );
  }

  if (draft.round !== view.round) draft = { round: view.round, text: "" };
  var typing = document.activeElement && document.activeElement.id === "answer";
  var left = el("span", { class: "muted" }, w.max - draft.text.length);
  var send = el("button", { id: "send", disabled: !draft.text.trim() }, "Send for the team");
  var box = el("textarea", {
    id: "answer",
    maxLength: w.max,
    rows: 3,
    placeholder: "Your team's funniest answer",
    value: draft.text,
    oninput: function () {
      draft.text = box.value;
      left.textContent = w.max - box.value.length;
      send.disabled = !box.value.trim();
    },
  });
  var form = el(
    "form",
    {
      class: "write",
      onsubmit: function (event) {
        event.preventDefault();
        if (box.value.trim()) game.send("answer", box.value);
      },
    },
    el("p", { class: "prompt" }, view.prompt),
    box,
    el("div", { class: "under" }, el("span", { class: "muted" }, "One answer per team. First one sent counts."), left),
    send,
    timer(view),
  );
  if (typing) setTimeout(function () { box.focus(); }, 0);
  return form;
}

function vote(view) {
  var v = view.voting;
  if (!v.canVote) {
    return center(
      el("p", { class: "big" }, "Fingers crossed"),
      el("p", { class: "muted", id: "sitting-out" }, "Your team's answer is up. The others are voting."),
    );
  }
  return el(
    "div",
    { class: "ballot" },
    el("p", { class: "prompt" }, view.prompt),
    v.options.map(function (option) {
      var cls = "";
      if (v.picked !== null) cls = option.index === v.picked ? "picked" : "dim";
      else if (!option.allowed) cls = "dim";
      return el(
        "button",
        {
          class: cls,
          disabled: v.picked !== null || !option.allowed,
          "data-option": option.index,
          onclick: function () { game.send("vote", option.index); },
        },
        el("span", { class: "text" }, option.text),
        option.own ? el("span", { class: "who" }, option.allowed ? "Your team's" : "Your team's (you can't vote for it)") : null,
      );
    }),
    el("p", { class: "muted" }, v.picked !== null ? "Vote in!" : "Tap the best answer."),
    timer(view),
  );
}

function result(view) {
  var r = view.result;
  var headline = r.won ? "Your team scores!" : r.winners.length ? list(r.winners) + (r.winners.length > 1 ? " score" : " scores") : "Nobody scores";
  return center(
    el("p", { class: "big " + (r.won ? "good" : ""), id: "result" }, headline),
    el("p", { class: "muted" }, view.prompt),
    r.answers.map(function (answer) {
      return el("p", { class: "quote" }, el("b", {}, answer.name + ": "), answer.text);
    }),
  );
}

function end(view) {
  var e = view.end;
  var headline = e.won
    ? e.champions.length > 1 ? "A draw at the top!" : "Your team won!"
    : e.place === null ? list(e.champions) + " won" : "Your team placed " + e.place + " of " + view.teams.length;
  return center(
    el("p", { class: "big " + (e.won ? "good" : ""), id: "place" }, headline),
    view.team === null ? null : el("p", { class: "muted" }, view.score + (view.score === 1 ? " point" : " points")),
  );
}

game.onView(function (view) {
  var body;
  if (view.phase === "lobby") body = teamPicker(view, view.team === null ? "Pick your team" : "You're on " + view.teamName);
  // Someone who arrives mid-game picks a team before anything else.
  else if (view.team === null) body = teamPicker(view, "Pick a team to join in");
  else if (view.phase === "write") body = write(view);
  else if (view.phase === "vote") body = vote(view);
  else if (view.phase === "result") body = result(view);
  else body = end(view);
  mount(app, frame(view, body));
});
