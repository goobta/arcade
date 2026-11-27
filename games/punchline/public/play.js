// The phone: pick a crew, write, heckle, vote, see how it went.
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
      view.phase === "lobby" ? "Tap another crew any time before the show starts." : "You'll join in from the next answer.",
    ),
    emcee(line, { cls: "phone" }),
  );
}

// ---------- writing ----------

function setTyping(status) {
  if (status === typingSent) return;
  typingSent = status;
  game.send("typing", status);
}

function presence(w) {
  return w.teammates.map(function (m) {
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

function writeForm(view) {
  var w = view.writing;
  if (draft.round !== view.round) {
    draft = { round: view.round, text: "" };
    typingSent = "idle";
  }
  var left = el("span", {}, w.max - draft.text.length + " left");
  var send = el("button", { id: "send", class: "big pink", type: "submit", disabled: !draft.text.trim() }, "Lock it in!");
  var people = el("div", { class: "presence" }, presence(w));
  var box = el("textarea", {
    id: "answer",
    maxLength: w.max,
    rows: 3,
    placeholder: "Make it sting",
    value: draft.text,
    oninput: function () {
      draft.text = box.value;
      left.textContent = w.max - box.value.length + " left";
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
    timebar(view, true),
    promptCard(view),
    el("label", { for: "answer" }, "Your crew's answer"),
    el("div", { class: "speech" }, box),
    el("div", { class: "under" }, el("span", {}, "First one sent counts. Huddle up!"), left),
    people,
    send,
  );
  return {
    node: form,
    update: function (next) {
      people.replaceChildren.apply(people, presence(next.writing));
    },
  };
}

function sealed(view) {
  var w = view.writing;
  return center(
    el("p", { class: "kicker" }, view.prompt),
    el(
      "div",
      { class: "sealed sticker" },
      el("span", { class: "tag" }, "YOUR CREW'S ANSWER"),
      el("p", { id: "sent" }, "“" + w.answer.text + "”"),
      el("span", { class: "stamp locked" + (once("sealed" + view.round) ? " in" : "") }, "LOCKED IN"),
    ),
    el("p", { class: "muted" }, "Sent by " + w.answer.by + ". Waiting for the other crews."),
  );
}

function heckle(view) {
  var w = view.writing;
  var buttons = w.heckles.map(function (kind, i) {
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
          heckleReadyAt = now + w.heckleGap;
          game.send("heckle", kind);
          var pop = el("span", { class: "pop", style: "left:" + (button.offsetLeft + button.offsetWidth / 2 - 30) + "px; top:" + (button.offsetTop - 10) + "px" }, kind);
          pop.addEventListener("animationend", function () {
            pop.remove();
          });
          grid.append(pop);
          button.classList.add("pressed");
          setTimeout(function () {
            button.classList.remove("pressed");
          }, w.heckleGap);
        },
      },
      kind,
    );
    return button;
  });
  var grid = el("div", { class: "heckles" }, buttons);
  return el(
    "div",
    { class: "heckle-screen" },
    el("div", { class: "heading" }, el("span", { class: "kicker" }, "YOU'RE A JUDGE THIS ROUND"), el("h1", {}, "Heckle the writers")),
    emcee(verb(w.teams, "is", "are") + " writing. Every tap pops up on the big screen. Heckle responsibly.", {
      cls: "phone",
      id: "waiting",
    }),
    grid,
    el("p", { class: "hint" }, "You vote as soon as the answers are in."),
  );
}

// ---------- voting ----------

function vote(view) {
  var v = view.voting;
  if (!v.canVote) {
    return center(
      mascot(view.team, 110, "focus", "bob"),
      el("h1", {}, "Fingers crossed"),
      el("p", { class: "muted", id: "sitting-out" }, "Your crew's answer is up. The others are voting."),
      timebar(view, false),
    );
  }
  var waiting =
    v.picked === null
      ? "Tap the one that got you."
      : v.waiting === 0
        ? "Vote's in!"
        : "Vote's in! Waiting on " + (v.waiting <= 2 ? list(v.waitingOn) : plural(v.waiting, "more judge")) + "…";
  return el(
    "div",
    { class: "ballot" },
    timebar(view, false),
    el("div", { class: "heading" }, el("span", { class: "kicker" }, view.prompt), el("h1", {}, "Which one got you?")),
    el(
      "div",
      { class: "options" + (v.options.length > 3 ? " many" : "") },
      v.options.map(function (option, i) {
        var picked = v.picked === option.index;
        var cls = "option sticker";
        if (picked) cls += " picked";
        else if (v.picked !== null || !option.allowed) cls += " dim";
        return el(
          "button",
          {
            class: cls,
            "aria-pressed": picked ? "true" : "false",
            disabled: v.picked !== null || !option.allowed,
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
            option.own ? el("span", { class: "who" }, option.allowed ? "Your crew's" : "Your crew's. No voting for yourselves!") : null,
          ),
          picked ? el("span", { class: "stamp vote" + (once("vote" + view.round) ? " in" : "") }, "YOUR VOTE") : null,
        );
      }),
    ),
    el("p", { class: "hint" }, waiting),
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
  if (view.phase === "write") {
    if (!view.writing.up) return heckle(view);
    if (view.writing.answer) return sealed(view);
    return writeForm(view);
  }
  if (view.phase === "vote") return vote(view);
  if (view.phase === "result") return result(view);
  return end(view);
}

game.onView(function (view) {
  var key = view.phase === "write" && view.team !== null && view.writing.up && !view.writing.answer ? "write:" + view.round : null;
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
