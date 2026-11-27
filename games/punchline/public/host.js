// The projector: a fixed 1280×720 comedy-club stage, scaled to fit the screen.
var game = Arcade.connect();
var app = document.getElementById("app");
var fx = document.getElementById("fx");
var stage = document.getElementById("stage");
showStatus(game);

var LETTERS = "ABCDEFGH";
/** Past this many players, or more than four crews, the lobby switches from cards to ticker lanes. */
var CARD_LOBBY_MAX_PLAYERS = 16;
var CARD_LOBBY_MAX_CREWS = 4;

var lastView = null;
var openMenu = null; // which lobby setting has its menu open

function fitStage() {
  var scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  stage.style.transform = "translate(-50%, -50%) scale(" + scale + ")";
}
window.addEventListener("resize", fitStage);
fitStage();

function send(type, data) {
  return function () {
    game.send(type, data);
  };
}

// ---------- pieces ----------

function bulbs(count) {
  var out = [];
  for (var i = 0; i < count; i++) out.push(el("span", { class: "bulb" + (i % 2 ? " b" : "") }));
  return el("div", { class: "bulbs" }, out);
}

function marquee(small) {
  return el(
    "div",
    { class: "marquee" + (small ? " small" : "") },
    bulbs(small ? 10 : 14),
    el("h1", {}, "PUNCHLINE"),
    small ? null : el("p", { class: "tagline" }, "The team comedy showdown"),
  );
}

function roundPill(view, extra) {
  return el("span", { class: "pill-round" }, "ROUND " + view.round + " OF " + view.total + (extra || ""));
}

/** The round countdown: a pink pie draining around the time left. */
function ring(view, tilt) {
  var face = el("div", { class: "face" }, "");
  var node = el("div", { class: "ring", role: "img", style: "transform: rotate(" + tilt + "deg)" }, face);
  if (view.deadline) {
    countdown(game, node, view.deadline, view.duration, function (left, frac) {
      node.style.setProperty("--left", frac.toFixed(4) + "turn");
      face.textContent = clockText(left);
      node.setAttribute("aria-label", Math.ceil(left / 1000) + " seconds left");
    });
  }
  return node;
}

function scorePills(view) {
  return el(
    "div",
    { class: "score-pills" + (view.teams.length > 4 ? " many" : "") },
    view.teams.map(function (team) {
      return el("span", { class: "score-pill " + crewClass(team.index) }, team.name + " · " + team.score);
    }),
  );
}

function names(teams) {
  return list(
    teams.map(function (team) {
      return team.name;
    }),
  );
}

// ---------- lobby ----------

function answeringText(config) {
  var n = config.answering === "all" || config.answering >= config.teams ? "all" : config.answering;
  return n === "all" ? "All crews answer" : n + " crews answer";
}

function settingsMenu(key, options, current) {
  return el(
    "div",
    { class: "menu", role: "menu" },
    options.map(function (option) {
      var change = {};
      change[key] = option.value;
      return el(
        "button",
        {
          class: option.value === current ? "on" : "",
          title: option.title || null,
          "data-set": key + "=" + option.value,
          onclick: function () {
            openMenu = null;
            game.send("configure", change);
          },
        },
        option.text,
      );
    }),
  );
}

/** A setting shown as a pill; tapping it opens a menu of choices above it. */
function settingPill(key, text, options, current) {
  return el(
    "div",
    { class: "setting" },
    el(
      "button",
      {
        class: "pill" + (openMenu === key ? " open" : ""),
        "data-menu": key,
        "aria-expanded": openMenu === key ? "true" : "false",
        onclick: function () {
          openMenu = openMenu === key ? null : key;
          render(lastView);
        },
      },
      text,
    ),
    openMenu === key ? settingsMenu(key, options, current) : null,
  );
}

/** The big-room lobby folds every setting into one pill, opening a panel of all of them. */
function settingsPanel(view, groups) {
  var config = view.config;
  var pack = view.packs.filter(function (entry) {
    return entry.id === config.pack;
  })[0];
  var summary = config.teams + " crews · " + config.rounds + " rounds" + (pack ? " · " + pack.name : "");
  return el(
    "div",
    { class: "setting" },
    el(
      "button",
      {
        class: "pill" + (openMenu === "all" ? " open" : ""),
        "data-menu": "all",
        "aria-expanded": openMenu === "all" ? "true" : "false",
        onclick: function () {
          openMenu = openMenu === "all" ? null : "all";
          render(lastView);
        },
      },
      summary,
    ),
    openMenu === "all"
      ? el(
          "div",
          { class: "menu panel", role: "menu" },
          groups.map(function (group) {
            return el("div", { class: "group" }, el("span", { class: "label" }, group.label), settingsMenu(group.key, group.options, group.current));
          }),
        )
      : null,
  );
}

function settings(view, compact) {
  var config = view.config;
  var pack = view.packs.filter(function (entry) {
    return entry.id === config.pack;
  })[0];
  var answering = config.answering !== "all" && config.answering >= config.teams ? "all" : config.answering;
  var answeringOptions = [];
  for (var n = 2; n < config.teams; n++) answeringOptions.push({ value: n, text: n + " crews" });
  answeringOptions.push({ value: "all", text: "All crews" });
  var crewOptions = [];
  for (var c = 2; c <= 8; c++) crewOptions.push({ value: c, text: c + " crews" });
  var packOptions = view.packs.map(function (entry) {
    return { value: entry.id, text: entry.name + " (" + entry.count + ")", title: entry.description };
  });
  var roundOptions = [3, 5, 8, 10].map(function (r) {
    return { value: r, text: r + " rounds" };
  });
  if (compact) {
    return el(
      "div",
      { class: "settings compact" },
      settingsPanel(view, [
        { label: "Crews", key: "teams", options: crewOptions, current: config.teams },
        { label: "Answering each round", key: "answering", options: answeringOptions, current: answering },
        { label: "Rounds", key: "rounds", options: roundOptions, current: config.rounds },
        { label: "Questions", key: "pack", options: packOptions, current: config.pack },
      ]),
    );
  }
  return el(
    "div",
    { class: "settings" },
    settingPill("teams", config.teams + " crews", crewOptions, config.teams),
    settingPill(
      "rounds",
      config.rounds + " rounds",
      [3, 5, 8, 10].map(function (r) {
        return { value: r, text: r + " rounds" };
      }),
      config.rounds,
    ),
    view.packs.length
      ? settingPill(
          "pack",
          (pack ? pack.name : "Pick a") + " pack",
          view.packs.map(function (entry) {
            return { value: entry.id, text: entry.name + " (" + entry.count + ")", title: entry.description };
          }),
          config.pack,
        )
      : null,
    settingPill("answering", answeringText(config), answeringOptions, answering),
  );
}

function roomCode(view, withQr) {
  return el(
    "div",
    { class: "room-code sticker" + (withQr ? " with-qr" : "") },
    el(
      "div",
      { class: "words" },
      el("span", { class: "label" }, "ROOM CODE"),
      el("span", { class: "code" }, view.code),
      el("span", { class: "join" }, (withQr ? "" : "Late? Join at ") + view.join),
    ),
    withQr ? el("img", { class: "qr", src: "/api/qr.svg?code=" + encodeURIComponent(view.code), alt: "QR code to join" }) : null,
  );
}

/** The crew that most needs people, if the crews are lopsided. */
function shortCrew(view) {
  var sizes = view.teams.map(function (team) {
    return team.members.length;
  });
  var most = Math.max.apply(null, sizes);
  var least = Math.min.apply(null, sizes);
  if (most - least < 2 || least > most * 0.7) return null;
  return view.teams[sizes.indexOf(least)];
}

function lobbyLine(view) {
  var short = shortCrew(view);
  var empty = view.teams.filter(function (team) {
    return team.members.length === 0;
  });
  if (view.players === 0) return "Grab your phone and join the party! The code's up there in lights.";
  if (empty.length) {
    return verb(
      empty.map(function (team) {
        return team.name;
      }),
      "is",
      "are",
    ) + " looking lonely. Somebody adopt them.";
  }
  if (short) return "Watch for your name! " + short.name + " could use reinforcements.";
  if (view.unassigned.length) {
    return "Grab your phone and pick a crew! Anyone still dithering when the curtain goes up joins the smallest crew.";
  }
  return pick(
    [
      "Crews are set. Snacks are judged. Hit the big pink button when you're ready.",
      plural(view.players, "comedian") + ", one stage. I've never been so nervous.",
    ],
    view.players,
  );
}

function lobbyActions(view, small) {
  return el(
    "div",
    { class: "actions" },
    el("button", { id: "shuffle", class: "ghost", onclick: send("shuffle") }, "Shuffle crews"),
    el("button", { id: "balance", class: "ghost" + (shortCrew(view) ? " nudge" : ""), onclick: send("balance") }, "Balance crews"),
    el(
      "button",
      { id: "start", class: "big pink" + (small ? " small" : ""), disabled: !!view.problem, title: view.problem || null, onclick: send("start") },
      "Raise the curtain!",
    ),
  );
}

var TILTS = [-3, 2, -1, 3, -2, 1];

function crewCard(team) {
  return el(
    "div",
    { class: "team sticker " + crewClass(team.index), "data-team": team.index },
    el("div", { class: "band" }),
    mascot(team.index, 92, "rest", "bob"),
    el("div", { class: "title" }, el("span", { class: "label" }, "Crew"), el("h2", {}, team.name)),
    team.members.length
      ? el(
          "ul",
          { class: "members" },
          team.members.map(function (m, i) {
            return el("li", { class: m.connected ? "" : "away", style: "--tilt:" + TILTS[i % TILTS.length] + "deg" }, m.name);
          }),
        )
      : el("p", { class: "empty" }, "Nobody yet. Be the first!"),
  );
}

function cardLobby(view) {
  return el(
    "div",
    { class: "screen lobby" },
    el("div", { class: "top" }, marquee(false), roomCode(view, false)),
    el("div", { class: "crews n" + view.teams.length }, view.teams.map(crewCard)),
    view.unassigned.length
      ? el(
          "p",
          { class: "choosing", id: "unassigned" },
          "Still choosing:",
          view.unassigned.slice(0, 8).map(function (name) {
            return el("span", {}, name);
          }),
          view.unassigned.length > 8 ? el("span", { class: "more" }, "+" + (view.unassigned.length - 8)) : null,
        )
      : null,
    el(
      "div",
      { class: "bottom" },
      emcee(lobbyLine(view), { signed: true, id: "rimshot" }),
      el(
        "div",
        { class: "controls" },
        el("div", { class: "row" }, settings(view), el("button", { class: "pill dim", onclick: Arcade.exit }, "Exit")),
        lobbyActions(view),
      ),
    ),
  );
}

/** One ticker lane: the crew's badge, then its members' names scrolling sideways. */
function lane(team, height, short) {
  var namesList = team.members.map(function (m, i) {
    return el("li", { class: m.connected ? "" : "away", style: "--tilt:" + TILTS[i % TILTS.length] + "deg" }, m.name);
  });
  var copy = namesList.map(function (node) {
    return node.cloneNode(true);
  });
  var track = el("ul", { class: "track" }, namesList, copy);
  var row = el(
    "div",
    { class: "lane " + crewClass(team.index), style: "height:" + height + "px", "data-team": team.index },
    el(
      "div",
      { class: "badge" },
      mascot(team.index, 56, "rest", "bob"),
      el(
        "div",
        { class: "who" },
        el("h2", {}, team.name),
        el("span", {}, team.members.length ? (short ? "short-handed!" : "players") : "nobody yet"),
      ),
      el("span", { class: "count" }, team.members.length),
    ),
    el("div", { class: "names" }, track),
  );
  row.track = track;
  row.dir = team.index % 2 ? "right" : "left";
  return row;
}

/** Once on the page: scroll lanes whose names overflow, keep the rest still. */
function startLanes(root) {
  root.querySelectorAll(".lane").forEach(function (row) {
    var track = row.querySelector(".track");
    var box = row.querySelector(".names");
    if (!track || !box) return;
    var half = track.scrollWidth / 2;
    if (half <= box.clientWidth) {
      // Everyone fits: drop the copy, no scrolling.
      var copies = [].slice.call(track.children, track.children.length / 2);
      copies.forEach(function (node) {
        node.remove();
      });
      return;
    }
    var seconds = Math.max(12, half / 45);
    track.style.animation =
      (row.getAttribute("data-team") % 2 ? "lane-right " : "lane-left ") + seconds.toFixed(1) + "s linear " + phaseDelay(seconds) + " infinite";
  });
}

function tickerLobby(view) {
  var n = view.teams.length;
  var scrolling = n > 4;
  var viewport = 476;
  var height = scrolling ? 110 : Math.floor((viewport - 12 * n) / n);
  var short = shortCrew(view);
  var lanes = view.teams.map(function (team) {
    return lane(team, height, short && short.index === team.index);
  });
  if (scrolling) {
    // The list twice over, rolling up by exactly one copy, loops seamlessly.
    lanes = lanes.concat(
      view.teams.map(function (team) {
        return lane(team, height, short && short.index === team.index);
      }),
    );
  }
  var seconds = n * 4;
  var roll = el(
    "div",
    { class: "roll", style: scrolling ? "animation: roll-up " + seconds + "s linear " + phaseDelay(seconds) + " infinite" : null },
    lanes,
  );
  var picked = view.players - view.unassigned.length;
  return el(
    "div",
    { class: "screen ticker" },
    el(
      "div",
      { class: "top" },
      marquee(true),
      el(
        "div",
        { class: "headcount" },
        el("span", { class: "total" }, plural(view.players, "comedian")),
        el(
          "span",
          { class: "sub", id: "unassigned" },
          "across " + plural(n, "crew") + "." + (view.unassigned.length ? " " + view.unassigned.length + " still picking." : picked ? " Everyone's picked!" : ""),
        ),
      ),
      roomCode(view, true),
    ),
    el("div", { class: "lanes" + (scrolling ? " fade" : "") }, roll),
    el(
      "div",
      { class: "bottom" },
      emcee(lobbyLine(view), { cls: "small", id: "rimshot" }),
      el(
        "div",
        { class: "controls" },
        el("div", { class: "row" }, settings(view, true), el("button", { class: "pill dim", onclick: Arcade.exit }, "Exit")),
        lobbyActions(view, true),
      ),
    ),
  );
}

function lobby(view) {
  var big = view.teams.length > CARD_LOBBY_MAX_CREWS || view.players > CARD_LOBBY_MAX_PLAYERS;
  return big ? tickerLobby(view) : cardLobby(view);
}

// ---------- writing ----------

function dots() {
  return el("span", { class: "dots" }, el("i", {}), el("i", {}), el("i", {}));
}

function writerCard(team, compact) {
  var typing = team.members.filter(function (m) {
    return m.typing === "typing";
  });
  var ideas = team.members.filter(function (m) {
    return m.typing === "idea";
  });
  var presence = typing
    .map(function (m) {
      return m.name + " is typing";
    })
    .concat(
      ideas.map(function (m) {
        return m.name + " has an idea";
      }),
    );
  if (presence.length > 2) presence = [presence[0], "+" + (presence.length - 1) + " more scribbling"];
  return el(
    "div",
    { class: "writer " + crewClass(team.index) + (team.submitted ? " done" : "") + (compact ? " compact" : ""), "data-team": team.index },
    mascot(team.index, compact ? 60 : 92, team.submitted ? "cheer" : "focus", team.submitted ? "" : "bob"),
    el(
      "div",
      { class: "text" },
      el("span", { class: "name" }, team.name),
      team.submitted
        ? el("span", { class: "state" }, "Answer sealed. Smug.")
        : el("span", { class: "state" }, "Scribbling", dots()),
      el(
        "span",
        { class: "sub" },
        team.submitted ? "Sent by " + team.sentBy : presence.length ? presence.join(" · ") : "Waiting for inspiration",
      ),
    ),
    team.submitted ? el("span", { class: "stamp locked" }, "LOCKED IN") : null,
  );
}

function write(view) {
  var up = view.teams.filter(function (team) {
    return team.answering;
  });
  var judges = view.teams.filter(function (team) {
    return !team.answering;
  });
  var done = up.filter(function (team) {
    return team.submitted;
  }).length;
  var line = judges.length
    ? fill(pick(QUIPS.writeJudges, "w" + view.round), { judges: names(judges) })
    : pick(QUIPS.writeEveryone, "w" + view.round);
  return el(
    "div",
    { class: "screen write" },
    el("div", { class: "top" }, roundPill(view), scorePills(view), ring(view, -4)),
    el(
      "div",
      { class: "prompt-card sticker" + (up.length > 3 ? " short" : "") },
      el("span", { class: "tag" }, "THE PROMPT"),
      el("p", { "data-fit": "28" }, view.prompt),
    ),
    el(
      "div",
      { class: "writers n" + up.length },
      up.map(function (team) {
        return writerCard(team, up.length > 3);
      }),
    ),
    el(
      "div",
      { class: "bottom" },
      emcee(line, { cls: "mid" }),
      el(
        "div",
        { class: "skip" },
        el("span", { id: "progress" }, done + " of " + up.length + " answers in"),
        el("button", { id: "next", class: "ghost dim", onclick: send("next") }, "Skip to voting"),
      ),
    ),
  );
}

// ---------- voting ----------

function ballotCards(view) {
  var n = view.ballot.length;
  var cards = view.ballot.map(function (text, i) {
    return el(
      "li",
      { class: "answer sticker", style: "--tilt:" + (i % 2 ? 2 : -2) + "deg" },
      el("span", { class: "letter" }, LETTERS[i]),
      el("p", { "data-fit": "18" }, text),
    );
  });
  return el(
    "div",
    { class: "ballot-wrap n" + n },
    el("ul", { class: "answers n" + n }, cards),
    n === 2 ? el("div", { class: "vs" }, "VS") : null,
  );
}

function votesIn(view) {
  var list = view.voterList;
  var many = list.length > 8;
  var shown = many
    ? list
        .filter(function (v) {
          return v.voted;
        })
        .slice(-7)
    : list;
  var left = list.length - shown.length;
  return el(
    "div",
    { class: "votes-in" + (many ? " many" : "") },
    el("span", { class: "count", id: "progress" }, view.votesIn + " of " + view.voters + " votes in"),
    many ? el("div", { class: "meter" }, el("i", { style: "width:" + ((view.votesIn / Math.max(1, view.voters)) * 100).toFixed(1) + "%" })) : null,
    el(
      "ul",
      {},
      shown.map(function (v) {
        return el(
          "li",
          { class: v.voted ? "" : "waiting" },
          v.voted ? avatar(v.name, v.team) : el("span", { class: "avatar pending" }, "?"),
          many ? null : el("span", { class: "name" }, v.name),
        );
      }),
      many && left > 0 ? el("li", {}, el("span", { class: "avatar more" }, "+" + left)) : null,
    ),
  );
}

function vote(view) {
  var judges = view.teams.filter(function (team) {
    return !team.answering;
  });
  var line = view.openVote
    ? pick(QUIPS.voteOpen, "v" + view.round)
    : fill(pick(QUIPS.vote, "v" + view.round), { judges: judges.length ? names(judges) : "Everyone" });
  return el(
    "div",
    { class: "screen vote" },
    el(
      "div",
      { class: "top" },
      roundPill(view, " · VOTE!"),
      el("div", { class: "prompt-mini sticker" }, el("p", { "data-fit": "18" }, view.prompt)),
      ring(view, 4),
    ),
    ballotCards(view),
    el(
      "div",
      { class: "bottom" },
      emcee(line, { cls: "mid" }),
      el("div", { class: "right" }, votesIn(view), el("button", { id: "next", class: "ghost dim", onclick: send("next") }, "Reveal now")),
    ),
  );
}

// ---------- reveal ----------

function headline(view) {
  var winners = view.results
    .filter(function (entry) {
      return entry.won;
    })
    .map(function (entry) {
      return entry.name;
    });
  if (!winners.length) return "Nobody scores. Tough crowd.";
  if (view.unopposed) return verb(winners, "scores", "score") + " unopposed";
  if (winners.length > 1) return "A tie: " + list(winners) + " each score";
  return verb(winners, "takes", "take") + " the round!";
}

function resultCard(entry, i, compact, round) {
  var votes = entry.voters.length;
  var showVoters = entry.voters.slice(0, compact ? 3 : 5);
  return el(
    "li",
    {
      class: "result sticker " + crewClass(entry.team) + (entry.won ? " won" : "") + (compact ? " compact" : ""),
      "data-team": entry.team,
      style: "--tilt:" + (i % 2 ? 1.5 : -1.5) + "deg",
    },
    el("div", { class: "band" }, entry.name.toUpperCase() + (entry.by ? " · BY " + entry.by.toUpperCase() : "")),
    el(
      "div",
      { class: "body" },
      el("p", { class: "text" + (entry.text ? "" : " none"), "data-fit": "16" }, entry.text || "No answer. Stage fright."),
      el(
        "div",
        { class: "tally" },
        votes || !entry.text
          ? el(
              "ul",
              { class: "voters" },
              showVoters.map(function (v) {
                return el("li", {}, avatar(v.name, v.team, compact ? 34 : 44));
              }),
              votes > showVoters.length ? el("li", {}, el("span", { class: "avatar more", style: "--size:" + (compact ? 34 : 44) + "px" }, "+" + (votes - showVoters.length))) : null,
            )
          : el("span", { class: "crickets" }, art(CRICKET), compact ? null : el("em", {}, "*chirp* … *chirp*")),
        el("span", { class: "votes" }, plural(votes, "vote")),
      ),
    ),
    entry.won ? el("span", { class: "stamp zing" + (once("zing" + round + entry.team) ? " in" : "") }, "ZING!") : null,
  );
}

var CRICKET =
  '<svg class="cricket" viewBox="0 0 80 50" width="72" height="45" aria-hidden="true">' +
  '<path d="M30 38 L22 48 M44 39 L48 48 M28 26 L12 14 L6 42" stroke="#1A1230" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<ellipse cx="40" cy="30" rx="22" ry="11" fill="#8C6A3A" stroke="#1A1230" stroke-width="4"/>' +
  '<circle cx="62" cy="25" r="8" fill="#8C6A3A" stroke="#1A1230" stroke-width="4"/>' +
  '<path d="M66 19 Q76 4 62 2 M62 18 Q64 4 52 4" stroke="#1A1230" stroke-width="3" fill="none" stroke-linecap="round"/>' +
  '<circle cx="65" cy="24" r="2" fill="#1A1230"/></svg>';

function laughTrack(view) {
  var max = Math.max(1, view.total);
  return el(
    "div",
    { class: "laugh-track" + (view.standings.length > 4 ? " two" : "") },
    el("span", { class: "label" }, "THE LAUGH TRACK · FIRST TO THE MIC WINS"),
    el(
      "ol",
      { class: "board" },
      view.standings.map(function (entry) {
        return el(
          "li",
          { class: crewClass(entry.team) },
          el("span", { class: "name" }, entry.name),
          el("span", { class: "bar" }, el("i", { style: "width:" + Math.max(3, (entry.score / max) * 100).toFixed(1) + "%" })),
          el("span", { class: "score" }, entry.score),
        );
      }),
    ),
  );
}

function result(view) {
  var last = view.round >= view.total;
  var n = view.results.length;
  var won = view.results.some(function (entry) {
    return entry.won;
  });
  if (won && once("confetti" + view.round)) confetti(fx, 28, 760);
  return el(
    "div",
    { class: "screen reveal" },
    el("div", { class: "top" }, el("h1", { id: "headline", "data-fit": "30" }, headline(view)), roundPill(view)),
    el("p", { class: "prompt-line" }, view.prompt),
    el(
      "ul",
      { class: "results n" + n },
      view.results.map(function (entry, i) {
        return resultCard(entry, i, n > 3, view.round);
      }),
    ),
    el(
      "div",
      { class: "bottom" },
      laughTrack(view),
      el("button", { id: "next", class: "big yellow", onclick: send("next") }, last ? "Final bows →" : "Next round →"),
    ),
  );
}

// ---------- final bows ----------

var CROWN =
  '<svg class="crown" viewBox="0 0 60 34" width="70" height="40" aria-hidden="true">' +
  '<path d="M4 30 L8 6 L20 18 L30 2 L40 18 L52 6 L56 30 Z" fill="#FFD23F" stroke="#1A1230" stroke-width="4" stroke-linejoin="round"/></svg>';

var BILLING = ["Headliner", "Opening act", "Heckled offstage"];

function placeOf(view, entry) {
  return (
    view.standings.filter(function (other) {
      return other.score > entry.score;
    }).length + 1
  );
}

function podium(view) {
  var top = view.standings.slice(0, 3);
  // Second on the left, first in the middle, third on the right.
  var order = top.length === 3 ? [top[1], top[0], top[2]] : top.length === 2 ? [top[1], top[0]] : top;
  return el(
    "div",
    { class: "podium" },
    order.map(function (entry) {
      var place = placeOf(view, entry);
      var rank = top.indexOf(entry);
      var mood = place === 1 ? "cheer" : rank === 2 ? "sulk" : "rest";
      return el(
        "div",
        { class: "step p" + (rank + 1) + " " + crewClass(entry.team), "data-team": entry.team },
        place === 1 ? art(CROWN) : null,
        mascot(entry.team, place === 1 ? 120 : 92, mood, place === 1 ? "hop" : rank === 1 ? "sway" : ""),
        el(
          "div",
          { class: "block" },
          el("span", { class: "place" }, place),
          el("span", { class: "name" }, entry.name),
          el("span", { class: "billing" }, BILLING[Math.min(place, 3) - 1] + " · " + plural(entry.score, "pt")),
        ),
      );
    }),
  );
}

function awardCard(label, title, sub, tilt) {
  return el(
    "div",
    { class: "award sticker", style: "--tilt:" + tilt + "deg" },
    el("span", { class: "label" }, label),
    el("span", { class: "title" }, title),
    el("span", { class: "sub" }, sub),
  );
}

function awardCards(view) {
  var a = view.awards || {};
  var crew = function (team) {
    return team === null || team === undefined ? "" : ", " + view.teams[team].name;
  };
  var cards = [];
  if (a.zinger) {
    cards.push(
      awardCard("BIGGEST ZINGER", "“" + a.zinger.text + "”", a.zinger.by + crew(a.zinger.team) + " · " + a.zinger.votes + " of " + a.zinger.eligible + " votes", -1.5),
    );
  }
  if (a.crickets) {
    var count = a.crickets.count;
    cards.push(
      awardCard(
        "THE CRICKETS AWARD",
        a.crickets.name,
        (count === 1 ? "One answer" : count === 2 ? "Two answers" : count + " answers") + ", zero votes. Iconic.",
        1.2,
      ),
    );
  }
  if (a.heckler) {
    cards.push(awardCard("LOUDEST HECKLER", a.heckler.name, plural(a.heckler.count, "heckle") + crew(a.heckler.team) + ". Security has been notified.", -0.8));
  }
  if (!cards.length) cards.push(awardCard("THE CRITICS SAY", "Nobody voted.", "A bold, experimental show.", -1.5));
  return cards;
}

function end(view) {
  var champs = view.champions.map(function (team) {
    return view.teams[team].name;
  });
  var rest = view.standings.slice(3);
  return el(
    "div",
    { class: "screen final" },
    el("div", { class: "spotlight" }),
    el(
      "div",
      { class: "top" },
      el("span", { class: "kicker" }, "FINAL BOWS"),
      el("h1", { id: "winner", "data-fit": "30" }, champs.length > 1 ? "It's a draw: " + list(champs) + " share the bill!" : verb(champs, "headlines", "headline") + " tonight!"),
    ),
    el(
      "div",
      { class: "main" },
      el(
        "div",
        { class: "left" },
        rest.length
          ? el(
              "p",
              { class: "also" },
              "Also on the bill: " +
                rest
                  .map(function (entry) {
                    return placeOf(view, entry) + ". " + entry.name + " (" + plural(entry.score, "pt") + ")";
                  })
                  .join(" · "),
            )
          : null,
        podium(view),
      ),
      el(
        "div",
        { class: "right" },
        awardCards(view),
        el(
          "div",
          { class: "row" },
          el("button", { id: "again", class: "big pink small", onclick: send("start") }, "Encore!"),
          el("button", { class: "ghost", onclick: send("lobby") }, "New crews"),
          el("button", { class: "ghost dim", onclick: send("exit") }, "Back to arcade"),
        ),
      ),
    ),
  );
}

// ---------- heckles ----------

var HECKLE_COLOURS = { "HA!": "#FFD23F", OOF: "#FF9EC7", WOW: "#7FB2FF", "*clap*": "#C9F0B5", BOO: "#FFB27A", zzz: "#E4DDF5" };
var MAX_HECKLES_ON_SCREEN = 8;

game.on("heckle", function (h) {
  if (!lastView || lastView.phase !== "write") return;
  var live = fx.querySelectorAll(".heckle");
  if (live.length >= MAX_HECKLES_ON_SCREEN) live[0].remove();
  // Float up from either side of the stage, clear of the prompt in the middle.
  // Spread across the stage, starting just above Rimshot's speech bubble.
  var x = 60 + Math.random() * 1080;
  var bubble = el(
    "div",
    {
      class: "heckle " + crewClass(h.team),
      style:
        "left:" + x.toFixed(0) + "px; top:" + (460 + Math.random() * 70).toFixed(0) + "px;" +
        "background:" + (HECKLE_COLOURS[h.kind] || "#FFD23F") + "; --tilt:" + (Math.random() * 14 - 7).toFixed(1) + "deg",
    },
    h.kind,
    el("small", {}, " — " + h.name),
  );
  bubble.addEventListener("animationend", function () {
    bubble.remove();
  });
  fx.append(bubble);
});

// ---------- render ----------

var SCREENS = { lobby: lobby, write: write, vote: vote, result: result, end: end };

function render(view) {
  lastView = view;
  if (view.phase !== "lobby") openMenu = null;
  if (view.phase !== "write") {
    fx.querySelectorAll(".heckle").forEach(function (node) {
      node.remove();
    });
  }
  mount(app, SCREENS[view.phase](view));
  if (view.phase === "lobby") startLanes(app);
}

// Close an open settings menu by clicking anywhere else.
document.addEventListener("click", function (event) {
  if (openMenu && !event.target.closest(".setting")) {
    openMenu = null;
    if (lastView) render(lastView);
  }
});

game.onView(render);
