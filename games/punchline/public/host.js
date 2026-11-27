// The projector: a comedy-club stage laid out at 1280×720 or larger, scaled to fill the window.
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

/**
 * The stage is never smaller than 1280×720, and grows along one side to match
 * the window's shape, so it fills the window whatever that shape is: a 16:9
 * projector gets exactly 1280×720, a squarer window a taller stage, an
 * ultrawide one a wider stage.
 */
function fitStage() {
  var scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  if (!(scale > 0)) return; // not on screen yet
  stage.style.width = Math.round(window.innerWidth / scale) + "px";
  stage.style.height = Math.round(window.innerHeight / scale) + "px";
  stage.style.transform = "translate(-50%, -50%) scale(" + scale + ")";
}

/**
 * A long prompt on a short stage pushes the bottom row off the edge. Shrink
 * the prompt, below what fitAll settled on, until the whole screen fits.
 */
function fitScreen() {
  var screen = app.firstElementChild;
  var prompt = screen && screen.querySelector(".prompt-card p");
  var last = screen && screen.lastElementChild;
  if (!prompt || !last) return;
  var room = screen.clientHeight - parseFloat(getComputedStyle(screen).paddingBottom);
  var size = parseFloat(getComputedStyle(prompt).fontSize);
  var min = Number(prompt.getAttribute("data-fit")) || 14;
  while (size > min && last.offsetTop + last.offsetHeight > room + 1) {
    size -= 2;
    prompt.style.fontSize = size + "px";
  }
}

function refit() {
  fitStage();
  if (!app.firstElementChild) return;
  fitAll(app);
  fitScreen();
}
window.addEventListener("resize", refit);
// ui.js refits the text once the fonts are in; the screen needs checking again after that.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
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
    el("h1", {}, say("title", "PUNCHLINE")),
    small ? null : el("p", { class: "tagline" }, say("tagline", "The team comedy showdown")),
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

// ---------- lobby ----------

/** What the host has typed as the AI theme but not sent yet, so a redraw does not eat it. */
var themeDraft = null;

function settingsMenu(key, options, current) {
  return el(
    "div",
    { class: "menu", role: "menu" },
    options.map(function (option) {
      var change = option.change;
      if (!change) {
        change = {};
        change[key] = option.value;
      }
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

/** A setting shown as a pill; tapping it opens a menu of choices (or `panel`, any content) above it. */
function settingPill(key, text, options, current, panel) {
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
    openMenu === key ? panel || settingsMenu(key, options, current) : null,
  );
}

/** The AI writer's two knobs: what the show is about, and how spicy, from Unc to NSFW. */
function aiControls(view) {
  var config = view.config;
  var levels = view.aiLevels;
  var theme = el("input", {
    id: "ai-theme",
    type: "text",
    maxLength: 200,
    placeholder: "Anything: the office party, camping, the 90s…",
    value: themeDraft === null ? config.aiTheme : themeDraft,
    oninput: function () {
      themeDraft = theme.value;
    },
    // Sent when the host is done typing, not on every key.
    onchange: function () {
      game.send("configure", { aiTheme: theme.value });
    },
  });
  var name = el("b", { id: "ai-level-name" }, levels[config.aiLevel]);
  var slider = el("input", {
    id: "ai-level",
    type: "range",
    min: 0,
    max: levels.length - 1,
    step: 1,
    value: config.aiLevel,
    "aria-label": "How spicy",
    oninput: function () {
      name.textContent = levels[slider.value];
    },
    onchange: function () {
      game.send("configure", { aiLevel: Number(slider.value) });
    },
  });
  return el(
    "div",
    { class: "ai-controls" },
    el("label", { class: "label", for: "ai-theme" }, "Theme (optional)"),
    theme,
    el("label", { class: "label", for: "ai-level" }, "Spice: ", name),
    slider,
    el(
      "div",
      { class: "ticks" },
      levels.map(function (level, i) {
        return el("span", { class: i === config.aiLevel ? "on" : "" }, level);
      }),
    ),
  );
}

/** The big-room lobby folds every setting into one pill, opening a panel of all of them. */
function settingsPanel(view, groups) {
  var config = view.config;
  var pack = view.packs.filter(function (entry) {
    return entry.id === config.pack;
  })[0];
  var questions = view.usesAi ? "✨ AI" : pack ? pack.name : "";
  var summary = config.teams + " crews · " + config.rounds + " rounds" + (questions ? " · " + questions : "");
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
            return el(
              "div",
              { class: "group" },
              group.label ? el("span", { class: "label" }, group.label) : null,
              group.node || settingsMenu(group.key, group.options, group.current),
            );
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
  var crewOptions = [];
  for (var c = 2; c <= 6; c++) crewOptions.push({ value: c, text: c + " crews" });
  // Every pack, then the AI writer when the server has a key for it.
  var packOptions = view.packs.map(function (entry) {
    return { value: entry.id, text: entry.name + " (" + entry.count + ")", title: entry.description, change: { pack: entry.id, source: "pack" } };
  });
  if (view.aiAvailable) {
    packOptions.push({ value: "ai", text: "✨ AI", title: "Prompts written for this show from your theme", change: { source: "ai" } });
  }
  var questions = view.usesAi ? "ai" : config.pack;
  var roundOptions = [3, 5, 8, 10].map(function (r) {
    return { value: r, text: r + " rounds" };
  });
  if (compact) {
    return el(
      "div",
      { class: "settings compact" },
      settingsPanel(
        view,
        [
          { label: "Crews", key: "teams", options: crewOptions, current: config.teams },
          { label: "Rounds", key: "rounds", options: roundOptions, current: config.rounds },
          { label: "Questions", key: "pack", options: packOptions, current: questions },
        ].concat(view.usesAi ? [{ node: aiControls(view) }] : []),
      ),
    );
  }
  return el(
    "div",
    { class: "settings" },
    settingPill("teams", config.teams + " crews", crewOptions, config.teams),
    settingPill("rounds", config.rounds + " rounds", roundOptions, config.rounds),
    packOptions.length ? settingPill("pack", view.usesAi ? "✨ AI prompts" : (pack ? pack.name : "Pick a") + " pack", packOptions, questions) : null,
    view.usesAi
      ? settingPill(
          "ai",
          view.aiLevels[config.aiLevel] + (config.aiTheme ? " · " + (config.aiTheme.length > 18 ? config.aiTheme.slice(0, 17) + "…" : config.aiTheme) : " · any theme"),
          null,
          null,
          el("div", { class: "menu panel ai", role: "group" }, aiControls(view)),
        )
      : null,
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
  if (view.aiError) return "My joke writer choked. " + view.aiError;
  if (view.players === 0) return say("lobbyEmpty", "Grab your phone and join the party! The code's up there in lights.");
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
  if (view.vip && !view.vip.holder) {
    return say("vipOpen", "One seat is still empty: the " + view.vip.title + "'s. Take it on your phone, and your votes count ×" + view.vip.votes + ".");
  }
  if (view.unassigned.length) {
    return say("lobbyChoosing", "Grab your phone and pick a crew! Anyone still dithering when the curtain goes up joins the smallest crew.");
  }
  return pick(
    say("lobbyReady", [
      "Crews are set. Snacks are judged. Hit the big pink button when you're ready.",
      plural(view.players, "comedian") + ", one stage. I've never been so nervous.",
    ]),
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
      say("start", "Raise the curtain!"),
    ),
  );
}

var TILTS = [-3, 2, -1, 3, -2, 1];

function memberClass(m) {
  return (m.connected ? "" : "away") + (m.vip ? " vip" : "");
}

/**
 * The guest-of-honour seat in the lobby: who is in it and where they sit, or
 * that it is still free. Clicking a taken seat empties it.
 */
function vipPill(view) {
  var v = view.vip;
  if (!v) return null;
  var h = v.holder;
  if (!h) {
    return el("span", { class: "pill vip-pill free", id: "vip" }, art(VIP_CROWN), v.title + ": seat open · votes ×" + v.votes);
  }
  var where = h.team === null ? "watching" : view.teams[h.team].name;
  return el(
    "button",
    { class: "pill vip-pill" + (h.connected ? "" : " away"), id: "vip", title: "Empty the seat", onclick: send("unseat") },
    art(VIP_CROWN),
    v.title + ": " + h.name + " · " + where + " · votes ×" + v.votes,
    el("span", { class: "x" }, "✕"),
  );
}

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
            return el("li", { class: memberClass(m), style: "--tilt:" + TILTS[i % TILTS.length] + "deg" }, m.name);
          }),
        )
      : el("p", { class: "empty" }, "Nobody yet. Be the first!"),
  );
}

function cardLobby(view) {
  return el(
    "div",
    { class: "screen lobby" },
    el("div", { class: "top" }, marquee(false), lookArt("troupe"), roomCode(view, false)),
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
        vipPill(view),
        lobbyActions(view),
      ),
    ),
  );
}

/** One ticker lane: the crew's badge, then its members' names scrolling sideways. */
function lane(team, height, short) {
  var namesList = team.members.map(function (m, i) {
    return el("li", { class: memberClass(m), style: "--tilt:" + TILTS[i % TILTS.length] + "deg" }, m.name);
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
        vipPill(view),
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

/** One crew's progress through the crew stage. Never what anyone wrote. */
function writerCard(team, compact, writeOpen) {
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
  var votes = plural(team.teamVotes, "crew vote");
  var state;
  if (team.submitted) state = el("span", { class: "state" }, team.writers > 1 ? "All locked. Picking a favourite." : "Answer sealed. Smug.");
  else if (writeOpen) state = el("span", { class: "state" }, "Scribbling", dots());
  else state = el("span", { class: "state" }, team.locked ? "Picking a favourite" : "Nothing locked. Stage fright.");
  return el(
    "div",
    { class: "writer " + crewClass(team.index) + (team.submitted ? " done" : "") + (compact ? " compact" : ""), "data-team": team.index },
    mascot(team.index, compact ? 60 : 92, team.submitted ? "cheer" : "focus", team.submitted ? "" : "bob"),
    el(
      "div",
      { class: "text" },
      el("span", { class: "name" }, team.name),
      state,
      el(
        "span",
        { class: "sub", "data-progress": team.locked + "/" + team.writers },
        team.locked + " of " + team.writers + " locked" + (team.teamVotes ? " · " + votes : presence.length ? " · " + presence.join(" · ") : ""),
      ),
    ),
    team.submitted ? el("span", { class: "stamp locked" }, "LOCKED IN") : null,
  );
}

function write(view) {
  var n = view.teams.length;
  var line = pick(view.writeOpen ? quips("write") : quips("crewVote"), "w" + view.round);
  return el(
    "div",
    { class: "screen write" },
    el("div", { class: "top" }, roundPill(view, view.writeOpen ? " · WRITE!" : " · CREW VOTE!"), scorePills(view), ring(view, -4)),
    el(
      "div",
      { class: "prompt-card sticker" + (n > 3 ? " short" : "") },
      el("span", { class: "tag" }, "THE PROMPT"),
      el("p", { "data-fit": "28" }, view.prompt),
      n > 3 ? null : lookArt("dancerLeft", "beside left sway"),
      n > 3 ? null : lookArt("dancerRight", "beside right sway"),
    ),
    el(
      "div",
      { class: "writers n" + n },
      view.teams.map(function (team) {
        return writerCard(team, n > 3, view.writeOpen);
      }),
    ),
    el(
      "div",
      { class: "bottom" },
      emcee(line, { cls: "mid" }),
      el(
        "div",
        { class: "skip" },
        el("span", { id: "progress" }, view.lockedIn + " of " + view.writers + " answers locked"),
        el("button", { id: "next", class: "ghost dim", onclick: send("next") }, "Skip to the vote"),
      ),
    ),
  );
}

/** The AI is writing this show's prompts. */
function generating(view) {
  var config = view.config;
  return el(
    "div",
    { class: "screen generating" },
    el("div", { class: "top" }, marquee(false), roomCode(view, false)),
    el(
      "div",
      { class: "writing-room" },
      el("h1", { id: "generating" }, "Writing your prompts", dots()),
      el(
        "p",
        { class: "brief" },
        plural(config.rounds, "prompt") + " · " + view.aiLevels[config.aiLevel] + (config.aiTheme ? " · “" + config.aiTheme + "”" : ""),
      ),
    ),
    el(
      "div",
      { class: "bottom" },
      emcee(pick(quips("generating"), view.code + config.aiTheme), { signed: true, id: "rimshot" }),
      el("button", { id: "cancel", class: "ghost dim", onclick: send("lobby") }, "Cancel"),
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
  // The guest of honour is always up there, voted or not; a big room then shows the latest few to finish.
  var guest = list.filter(function (v) {
    return v.vip;
  });
  var shown = many
    ? guest.concat(
        list
          .filter(function (v) {
            return v.voted && !v.vip;
          })
          .slice(guest.length - 7),
      )
    : list;
  var left = list.length - shown.length;
  return el(
    "div",
    { class: "votes-in" + (many ? " many" : "") },
    el("span", { class: "count", id: "progress" }, view.votesIn + " of " + view.voters + " judges done"),
    many ? el("div", { class: "meter" }, el("i", { style: "width:" + ((view.votesIn / Math.max(1, view.voters)) * 100).toFixed(1) + "%" })) : null,
    el(
      "ul",
      {},
      shown.map(function (v) {
        return el(
          "li",
          { class: (v.voted ? "" : "waiting") + (v.vip ? " vip" : "") },
          v.voted || v.vip ? avatar(v.name, v.team, 0, v.vip) : el("span", { class: "avatar pending" }, "?"),
          many && !v.vip ? null : el("span", { class: "name" }, v.name),
        );
      }),
      many && left > 0 ? el("li", {}, el("span", { class: "avatar more" }, "+" + left)) : null,
    ),
  );
}

function vote(view) {
  var line = pick(view.votesEach > 1 ? quips("voteTwo") : quips("vote"), "v" + view.round);
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

function resultCard(entry, i, compact, round, weight) {
  var votes = entry.votes;
  var showVoters = entry.voters.slice(0, compact ? 3 : 5);
  var hidden = entry.voters.length - showVoters.length;
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
                return el(
                  "li",
                  { class: v.vip ? "vip" : "" },
                  avatar(v.name, v.team, compact ? 34 : 44, v.vip),
                  v.vip && weight > 1 ? el("span", { class: "times" }, "×" + weight) : null,
                );
              }),
              hidden > 0 ? el("li", {}, el("span", { class: "avatar more", style: "--size:" + (compact ? 34 : 44) + "px" }, "+" + hidden)) : null,
            )
          : el("span", { class: "crickets" }, art(CRICKET), compact ? null : el("em", {}, say("crickets", "*chirp* … *chirp*"))),
        el("span", { class: "votes" }, plural(votes, "vote")),
      ),
    ),
    entry.won ? el("span", { class: "stamp zing" + (once("zing" + round + entry.team) ? " in" : "") }, say("zing", "ZING!")) : null,
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
  if (won && once("confetti" + view.round)) confetti(fx, 28, stage.clientHeight + 40);
  return el(
    "div",
    { class: "screen reveal" },
    el("div", { class: "top" }, el("h1", { id: "headline", "data-fit": "30" }, headline(view)), roundPill(view)),
    el("p", { class: "prompt-line" }, view.prompt),
    el(
      "ul",
      { class: "results n" + n },
      view.results.map(function (entry, i) {
        return resultCard(entry, i, n > 3, view.round, view.vip ? view.vip.votes : 1);
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
          el("span", { class: "billing" }, say("billing", BILLING)[Math.min(place, 3) - 1] + " · " + plural(entry.score, "pt")),
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
      awardCard(say("zingerAward", "BIGGEST ZINGER"), "“" + a.zinger.text + "”", a.zinger.by + crew(a.zinger.team) + " · " + a.zinger.votes + " of " + a.zinger.eligible + " votes", -1.5),
    );
  }
  if (a.crickets) {
    var count = a.crickets.count;
    cards.push(
      awardCard(
        say("cricketsAward", "THE CRICKETS AWARD"),
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
      el("span", { class: "kicker" }, say("finalKicker", "FINAL BOWS")),
      el("h1", { id: "winner", "data-fit": "30" }, champs.length > 1 ? "It's a draw: " + list(champs) + " share the bill!" : verb(champs, "headlines", "headline") + " tonight!"),
    ),
    lookArt("cheer"),
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
          el("button", { id: "again", class: "big pink small", onclick: send("start") }, say("encore", "Encore!")),
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
  if (!lastView || lastView.phase !== "team") return;
  var live = fx.querySelectorAll(".heckle");
  if (live.length >= MAX_HECKLES_ON_SCREEN) live[0].remove();
  // Float up from either side of the stage, clear of the prompt in the middle.
  // Spread across the stage, starting just above Rimshot's speech bubble.
  var x = 60 + Math.random() * (stage.clientWidth - 200);
  var bubble = el(
    "div",
    {
      class: "heckle " + crewClass(h.team),
      style:
        "left:" + x.toFixed(0) + "px; top:" + (stage.clientHeight - 260 + Math.random() * 70).toFixed(0) + "px;" +
        "background:" + (HECKLE_COLOURS[h.kind] || "#FFD23F") + "; --tilt:" + (Math.random() * 14 - 7).toFixed(1) + "deg",
    },
    heckleLabel(h.kind),
    el("small", {}, " — " + (h.vip ? "♛ " : "") + h.name),
  );
  bubble.addEventListener("animationend", function () {
    bubble.remove();
  });
  fx.append(bubble);
});

// ---------- render ----------

var SCREENS = { lobby: lobby, generating: generating, team: write, vote: vote, result: result, end: end };

function render(view) {
  lastView = view;
  if (setLook(view.theme)) {
    // The tent's canopy hangs over the stage, behind every screen.
    stage.querySelectorAll(".canopy").forEach(function (node) {
      node.remove();
    });
    var canopy = lookArt("canopy");
    if (canopy) stage.prepend(canopy);
  }
  if (view.phase !== "lobby") openMenu = null;
  if (view.phase !== "team") {
    fx.querySelectorAll(".heckle").forEach(function (node) {
      node.remove();
    });
  }
  if (view.phase !== "lobby") themeDraft = null;
  // Redrawing must not pull the theme box out from under the host's fingers.
  var typing = document.activeElement && document.activeElement.id === "ai-theme" ? document.activeElement : null;
  var caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
  mount(app, SCREENS[view.phase](view));
  fitScreen();
  if (view.phase === "lobby") startLanes(app);
  if (typing) {
    var box = document.getElementById("ai-theme");
    if (box) {
      box.focus();
      box.setSelectionRange(caret[0], caret[1]);
    }
  }
}

// Close an open settings menu by clicking anywhere else.
document.addEventListener("click", function (event) {
  if (openMenu && !event.target.closest(".setting")) {
    openMenu = null;
    if (lastView) render(lastView);
  }
});

game.onView(render);
