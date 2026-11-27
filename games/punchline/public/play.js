// The phone: pick a crew, write and lock an answer, back a teammate's, vote, see how it went.
var game = Arcade.connect();
var app = document.getElementById("app");
var fx = document.getElementById("fx");
showStatus(game);

var LETTERS = "ABCDEFGH";
var HECKLE_COLOURS = { "HA!": "#FFD23F", OOF: "#FF9EC7", WOW: "#7FB2FF", "*clap*": "#C9F0B5", BOO: "#FFB27A", zzz: "#E4DDF5" };

// What the player has typed so far. The page is redrawn whenever the view
// changes (a teammate typing, say), and that must not eat a half-written answer.
var draft = { round: 0, text: "" };
// What this phone last told the server about its typing: "typing", "idea" or "idle".
var typingSent = "idle";
var typingTimer = null;
var heckleReadyAt = 0;
// The write screen is kept on the page and patched while the player types,
// so a teammate's "is typing…" never recreates the text box under their thumbs.
var live = null; // { key, update(view) }

function center() {
  return el.apply(null, ["div", { class: "center" }].concat([].slice.call(arguments)));
}

function topBar(view) {
  if (view.phase === "lobby" || view.team === null) {
    return el(
      "div",
      { class: "top" },
      el("span", { class: "logo" }, "PUNCHLINE"),
      el("span", { class: "me" }, "You're " + view.name),
    );
  }
  return el(
    "div",
    { class: "top" },
    el("span", { class: "crew-chip " + crewClass(view.team), id: "team" }, mascot(view.team, 26, "rest"), view.teamName),
    el("span", { class: "round" }, "Round " + Math.min(view.round, view.total) + " of " + view.total),
    el("span", { class: "score" }, plural(view.score, "pt")),
  );
}

/** The time left as a bar with a sparkle riding its tip. */
function timebar(view, spark) {
  var fillBar = el("i", {});
  var star = spark ? el("span", { class: "spark" }) : null;
  var label = el("span", { class: "left" }, "");
  var node = el("div", { class: "timebar", role: "img" }, fillBar, star, label);
  if (view.deadline) {
    countdown(game, node, view.deadline, view.duration, function (left, frac) {
      fillBar.style.width = (frac * 100).toFixed(2) + "%";
      if (star) star.style.left = "calc(" + (frac * 100).toFixed(2) + "% - 11px)";
      label.textContent = clockText(left);
      node.setAttribute("aria-label", Math.ceil(left / 1000) + " seconds left");
    });
  }
  return node;
}

function membersText(team, view) {
  var mine = team.index === view.team;
  var others = team.members.slice();
  if (mine && others.lastIndexOf(view.name) >= 0) others.splice(others.lastIndexOf(view.name), 1);
  if (!others.length) return mine ? "Just you so far" : "Nobody yet. Be the first!";
  var shown = others.slice(0, 3);
  var more = others.length - shown.length;
  var names = shown.concat(more ? [more + " more"] : []).concat(mine ? ["you"] : []);
  return list(names);
}

// ---------- lobby ----------

function picker(view, heading) {
  var many = view.teams.length > 4;
  var line =
    view.team === null
      ? fill("Pick a crew, {name}. Snacks are judged harshly here.", { name: view.name })
      : "Great pick, " + view.name + ". " + CREW_QUIPS[view.team];
  return el(
    "div",
    { class: "picker" },
    el("h1", {}, heading),
    el(
      "div",
      { class: "crews" + (many ? " many" : "") },
      view.teams.map(function (team) {
        var mine = team.index === view.team;
        return el(
          "button",
          {
            class: "crew sticker " + crewClass(team.index) + (mine ? " picked" : ""),
            "aria-pressed": mine ? "true" : "false",
            "data-team": team.index,
            onclick: function () {
              game.send("join", team.index);
            },
          },
          mascot(team.index, many ? 44 : 70, "rest", mine ? "bob" : ""),
          el(
            "span",
            { class: "words" },
            el("span", { class: "name" }, team.name),
            el("span", { class: "who" }, many ? plural(team.members.length, "player") : membersText(team, view)),
          ),
          mine ? el("span", { class: "tag" }, "YOU'RE IN") : null,
        );
      }),
    ),
    el(
      "p",
      { class: "hint" },
      view.phase === "lobby" ? "Tap another crew any time before the show starts." : "You'll join in straight away.",
    ),
    emcee(line, { cls: "phone" }),
  );
}

// ---------- the crew stage: write, lock, back a teammate ----------

function setTyping(status) {
  if (status === typingSent) return;
  typingSent = status;
  game.send("typing", status);
}

function presence(h) {
  return h.teammates.map(function (m) {
    if (m.typing === "typing") return el("span", { class: "who typing" }, m.name + " is typing", dots());
    if (m.typing === "idea") return el("span", { class: "who idea" }, m.name + " has an idea");
    return el("span", { class: "who idle" }, m.name + " " + pick(QUIPS.idle, m.name));
  });
}

function dots() {
  return el("span", { class: "dots" }, el("i", {}), el("i", {}), el("i", {}));
}

function promptCard(view) {
  return el("div", { class: "prompt-card sticker" }, el("span", { class: "tag" }, "THE PROMPT"), el("p", { "data-fit": "20" }, view.prompt));
}

/**
 * The crew-stage clock: "WRITE" drains until writing closes, then "VOTE!" for
 * the last few seconds. It runs off the deadlines alone, so it does not need
 * redrawing when writing closes.
 */
function stageBar(view) {
  var fillBar = el("i", {});
  var star = el("span", { class: "spark" });
  var label = el("span", { class: "left" }, "");
  var node = el("div", { class: "timebar staged", role: "img" }, fillBar, star, label);
  if (view.deadline) {
    countdown(game, node, view.deadline, view.duration, function (left) {
      var voteMs = view.deadline - view.writeDeadline;
      var writing = left > voteMs;
      var part = writing ? left - voteMs : left;
      var frac = Math.min(1, part / (writing ? view.writeDuration : voteMs));
      node.classList.toggle("voting", !writing);
      fillBar.style.width = (frac * 100).toFixed(2) + "%";
      star.style.left = "calc(" + (frac * 100).toFixed(2) + "% - 11px)";
      label.textContent = (writing ? "WRITE · " : "VOTE! · ") + clockText(part);
      node.setAttribute("aria-label", Math.ceil(part / 1000) + " seconds left to " + (writing ? "write" : "vote"));
    });
  }
  return node;
}

/** Teammates' locked answers, as cards to tap. Your own is not in here: it has its own card. */
function mates(view) {
  var h = view.huddle;
  var others = h.answers.filter(function (answer) {
    return !answer.mine;
  });
  if (!others.length) return [];
  return [
    el("span", { class: "kicker" }, h.canVote ? "BACK YOUR CREW'S BEST" : "LOCKED IN BY YOUR CREW"),
    el(
      "div",
      { class: "options many mates" },
      others.map(function (answer, i) {
        var cls = "option sticker";
        if (answer.picked) cls += " picked";
        else if (!h.canVote) cls += " dim";
        return el(
          "button",
          {
            class: cls,
            type: "button",
            "aria-pressed": answer.picked ? "true" : "false",
            disabled: !h.canVote,
            "data-author": answer.id,
            style: "--tilt:" + (i % 2 ? 1 : -1) + "deg",
            onclick: function () {
              game.send("teamVote", answer.id);
            },
          },
          avatar(answer.byName, view.team, 40),
          el(
            "span",
            { class: "words" },
            el("span", { class: "text" }, answer.text),
            el("span", { class: "who" }, answer.byName + " · " + plural(answer.votes, "vote")),
          ),
          answer.picked ? el("span", { class: "stamp vote" + (once("pick" + view.round + answer.id) ? " in" : "") }, "YOUR PICK") : null,
        );
      }),
    ),
  ];
}

function writeForm(view) {
  var h = view.huddle;
  if (draft.round !== view.round) {
    draft = { round: view.round, text: "" };
    typingSent = "idle";
  }
  var left = el("span", {}, h.max - draft.text.length + " left");
  var send = el("button", { id: "send", class: "big pink", type: "submit", disabled: !draft.text.trim() }, "Lock it in!");
  var people = el("div", { class: "presence" }, presence(h));
  var crew = el("div", { class: "crew-answers" }, mates(view));
  var box = el("textarea", {
    id: "answer",
    maxLength: h.max,
    rows: 3,
    placeholder: "Make it sting",
    value: draft.text,
    oninput: function () {
      draft.text = box.value;
      left.textContent = h.max - box.value.length + " left";
      send.disabled = !box.value.trim();
      setTyping(box.value.trim() ? "typing" : "idle");
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () {
        setTyping(box.value.trim() ? "idea" : "idle");
      }, 2500);
    },
  });
  var form = el(
    "form",
    {
      class: "write",
      onsubmit: function (event) {
        event.preventDefault();
        clearTimeout(typingTimer);
        if (box.value.trim()) game.send("answer", box.value);
      },
    },
    stageBar(view),
    promptCard(view),
    el("label", { for: "answer" }, "Your answer"),
    el("div", { class: "speech" }, box),
    el("div", { class: "under" }, el("span", {}, "Lock yours in, then vote for a teammate's."), left),
    send,
    people,
    crew,
  );
  return {
    node: form,
    update: function (next) {
      people.replaceChildren.apply(people, presence(next.huddle));
      crew.replaceChildren.apply(crew, mates(next));
    },
  };
}

function heckleButtons(h) {
  var grid = el(
    "div",
    { class: "heckles row" },
    h.heckles.map(function (kind, i) {
      var button = el(
        "button",
        {
          class: "heckle-btn",
          type: "button",
          "data-heckle": kind,
          style: "background:" + (HECKLE_COLOURS[kind] || "#FFD23F") + "; --tilt:" + [-2, 2, 1, -1.5, -2, 1.5][i % 6] + "deg",
          onclick: function () {
            var now = Date.now();
            if (now < heckleReadyAt) return;
            heckleReadyAt = now + h.heckleGap;
            game.send("heckle", kind);
            var pop = el("span", { class: "pop", style: "left:" + (button.offsetLeft + button.offsetWidth / 2 - 30) + "px; top:" + (button.offsetTop - 10) + "px" }, kind);
            pop.addEventListener("animationend", function () {
              pop.remove();
            });
            grid.append(pop);
            button.classList.add("pressed");
            setTimeout(function () {
              button.classList.remove("pressed");
            }, h.heckleGap);
          },
        },
        kind,
      );
      return button;
    }),
  );
  return grid;
}

/** After locking (or once writing has closed): your answer, your crew's, and something to do while the clock runs. */
function huddle(view) {
  var h = view.huddle;
  var others = h.answers.length - (h.mine ? 1 : 0);
  var hint;
  if (!others) hint = h.writeOpen ? "Waiting for your crew to lock theirs in." : h.mine ? "Yours goes up for your crew." : "Nobody locked one in. Your crew sits this one out.";
  else if (!h.myVote) hint = "Tap the answer your crew should send up.";
  else hint = "Vote's in! Tap another to change it.";
  return el(
    "div",
    { class: "huddle" },
    stageBar(view),
    el("p", { class: "kicker" }, view.prompt),
    h.mine
      ? el(
          "div",
          { class: "sealed sticker" },
          el("span", { class: "tag" }, "YOUR ANSWER"),
          el("p", { id: "sent" }, "“" + h.mine + "”"),
          el("span", { class: "stamp locked" + (once("sealed" + view.round) ? " in" : "") }, "LOCKED IN"),
        )
      : el("h1", { id: "too-late" }, "Pens down!"),
    mates(view),
    el("p", { class: "muted", id: "huddle-hint" }, hint),
    el("div", { class: "while-waiting" }, el("span", { class: "kicker" }, "HECKLE WHILE YOU WAIT"), heckleButtons(h)),
  );
}

/** The AI is writing the show's prompts. */
function generating(view) {
  return center(
    mascot(view.team, 110, "focus", "bob"),
    el("h1", { id: "generating" }, "Writing your prompts", dots()),
    el("p", { class: "muted" }, "Fresh material, made for this room. Eyes on the big screen."),
  );
}

// ---------- the final vote ----------

function vote(view) {
  var v = view.voting;
  var waiting;
  if (!v.canVote) waiting = "Nothing for you to vote on this round.";
  else if (v.left > 0) waiting = (v.limit > 1 ? "Votes left: " + v.left + ". Two different answers." : "Tap the one that got you.");
  else if (v.waiting === 0) waiting = "Votes are in!";
  else waiting = (v.limit > 1 ? "Votes are in!" : "Vote's in!") + " Tap again to change. Waiting on " + (v.waiting <= 2 ? list(v.waitingOn) : plural(v.waiting, "more judge")) + "…";
  return el(
    "div",
    { class: "ballot" },
    timebar(view, false),
    el(
      "div",
      { class: "heading" },
      el("span", { class: "kicker" }, view.prompt),
      el("h1", {}, v.limit > 1 ? "Pick your top " + v.limit : "Which one got you?"),
    ),
    el(
      "div",
      { class: "options" + (v.options.length > 3 ? " many" : "") },
      v.options.map(function (option, i) {
        var cls = "option sticker";
        if (option.picked) cls += " picked";
        else if (!option.allowed) cls += " dim";
        return el(
          "button",
          {
            class: cls,
            "aria-pressed": option.picked ? "true" : "false",
            disabled: !option.allowed,
            "data-option": option.index,
            style: "--tilt:" + (i % 2 ? 1.5 : -1.5) + "deg",
            onclick: function () {
              game.send("vote", option.index);
            },
          },
          el("span", { class: "letter" }, LETTERS[option.index]),
          el(
            "span",
            { class: "words" },
            el("span", { class: "text" }, option.text),
            option.yours ? el("span", { class: "who" }, "Yours. No voting for yourself!") : option.own ? el("span", { class: "who" }, "Your crew's") : null,
          ),
          option.picked ? el("span", { class: "stamp vote" + (once("vote" + view.round + "-" + option.index) ? " in" : "") }, "YOUR VOTE") : null,
        );
      }),
    ),
    el("p", { class: "hint", id: "votes-left" }, waiting),
  );
}

// ---------- results ----------

function result(view) {
  var r = view.result;
  var mine = r.mine;
  var cricket = mine && mine.votes === 0 && mine.eligible > 0;
  var head;
  if (r.won) head = "Your crew scored!";
  else if (cricket) head = "Crickets.";
  else if (r.winners.length) head = verb(r.winners, "scores", "score");
  else head = "Nobody scores";
  if (r.won && once("confetti" + view.round)) confetti(fx, 16, 900);
  var card = mine
    ? el(
        "div",
        { class: "mine sticker" },
        el("span", { class: "tag" }, (mine.by + "'s answer").toUpperCase()),
        el("span", { class: "text" }, mine.text),
        el(
          "span",
          { class: "sub" },
          r.unopposed ? "Unopposed. A win's a win." : mine.votes + " of " + mine.eligible + " judges picked it",
        ),
        r.won ? el("span", { class: "plus" }, "+1") : null,
      )
    : el(
        "div",
        { class: "answers-list" },
        r.answers.map(function (answer) {
          return el("p", { class: "quote" }, el("b", {}, answer.name + ": "), answer.text);
        }),
      );
  return el(
    "div",
    { class: "result-screen" },
    r.won ? el("span", { class: "stamp zing" + (once("zing" + view.round) ? " in" : "") }, "ZING!") : null,
    r.won
      ? mascot(view.team, 110, "cheer", "hop")
      : cricket
        ? art(CRICKET_ART)
        : mascot(view.team, 96, mine && r.winners.length ? "sulk" : "rest", "bob"),
    el("h1", { id: "result", class: r.won ? "good" : "" }, head),
    card,
    r.place ? el("p", { class: "hint" }, verb([view.teamName], "is", "are") + " in " + ordinal(r.place) + ". Eyes on the big screen.") : null,
  );
}

var CRICKET_ART =
  '<svg class="cricket bob" viewBox="0 0 80 50" width="120" height="75" aria-hidden="true">' +
  '<path d="M30 38 L22 48 M44 39 L48 48 M28 26 L12 14 L6 42" stroke="#1A1230" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<ellipse cx="40" cy="30" rx="22" ry="11" fill="#8C6A3A" stroke="#1A1230" stroke-width="4"/>' +
  '<circle cx="62" cy="25" r="8" fill="#8C6A3A" stroke="#1A1230" stroke-width="4"/>' +
  '<path d="M66 19 Q76 4 62 2 M62 18 Q64 4 52 4" stroke="#1A1230" stroke-width="3" fill="none" stroke-linecap="round"/>' +
  '<circle cx="65" cy="24" r="2" fill="#1A1230"/></svg>';

function end(view) {
  var e = view.end;
  var headline = e.won
    ? e.champions.length > 1
      ? "A draw at the top!"
      : "Your crew headlined!"
    : e.place === null
      ? list(e.champions) + " won"
      : "Your crew placed " + e.place + " of " + view.teams.length;
  var mine = [];
  var a = e.awards || {};
  if (a.zinger && a.zinger.by === view.name) mine.push(["BIGGEST ZINGER", "“" + a.zinger.text + "”"]);
  if (a.crickets && a.crickets.name === view.name) mine.push(["THE CRICKETS AWARD", "Zero votes. Iconic."]);
  if (a.heckler && a.heckler.name === view.name) mine.push(["LOUDEST HECKLER", plural(a.heckler.count, "heckle") + ". Legend."]);
  if (e.won && once("confetti-end")) confetti(fx, 20, 900);
  return center(
    view.team === null ? null : mascot(view.team, 120, e.won ? "cheer" : e.place === view.teams.length ? "sulk" : "rest", e.won ? "hop" : "bob"),
    el("span", { class: "kicker" }, "FINAL BOWS"),
    el("h1", { class: e.won ? "good" : "", id: "place" }, headline),
    view.team === null ? null : el("p", { class: "muted" }, plural(view.score, "point")),
    mine.map(function (award, i) {
      return el(
        "div",
        { class: "mine sticker", style: "--tilt:" + (i % 2 ? 1 : -1) + "deg" },
        el("span", { class: "tag" }, "YOU WON: " + award[0]),
        el("span", { class: "text" }, award[1]),
      );
    }),
    el("p", { class: "hint" }, "Eyes on the big screen."),
  );
}

// ---------- render ----------

function screen(view) {
  // Someone who arrives mid-game picks a crew before anything else.
  if (view.phase === "lobby") return picker(view, view.team === null ? "Pick your crew" : "You're in!");
  if (view.team === null) return picker(view, "Pick a crew to join in");
  if (view.phase === "generating") return generating(view);
  if (view.phase === "team") return view.huddle.writeOpen && !view.huddle.mine ? writeForm(view) : huddle(view);
  if (view.phase === "vote") return vote(view);
  if (view.phase === "result") return result(view);
  return end(view);
}

game.onView(function (view) {
  var h = view.huddle;
  var key = view.phase === "team" && h && h.writeOpen && !h.mine ? "write:" + view.round : null;
  if (key && live && live.key === key) {
    live.update(view);
    var bar = app.querySelector(".top");
    if (bar) bar.replaceWith(topBar(view));
    return;
  }
  if (!key && typingSent !== "idle") typingSent = "idle";
  var built = screen(view);
  live = null;
  if (built && built.update) {
    live = { key: key, update: built.update };
    built = built.node;
  }
  var focused = document.activeElement && document.activeElement.id === "answer";
  mount(app, el("div", { class: "phone-screen phase-" + view.phase }, topBar(view), built));
  if (focused) {
    var box = document.getElementById("answer");
    if (box) box.focus();
  }
});
