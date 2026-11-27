// Shared by the projector and phone pages: a tiny DOM helper, the crews'
// mascots, Rimshot the emcee and his lines, clocks, confetti and text fitting.

// el("button", { class: "quiet", onclick: fn }, "Next")
function el(tag, props) {
  var node = document.createElement(tag);
  Object.keys(props || {}).forEach(function (key) {
    var value = props[key];
    if (value === null || value === undefined || value === false) return;
    if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "style") node.setAttribute("style", value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  });
  for (var i = 2; i < arguments.length; i++) {
    var child = arguments[i];
    if (child === null || child === undefined || child === false) continue;
    (Array.isArray(child) ? child : [child]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.append(c.nodeType ? c : String(c));
    });
  }
  return node;
}

/** A node from trusted markup in this file (the SVG art). Never pass player text here. */
function art(markup) {
  var holder = document.createElement("div");
  holder.innerHTML = markup.trim();
  return holder.firstChild;
}

function mount(root, node) {
  root.replaceChildren(node);
  fitAll(root);
}

function list(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/** "Hot Sauce scores", "Pickles score": every crew but Hot Sauce is a plural noun. */
function verb(names, singular, pluralForm) {
  var many = names.length > 1 || /s$/.test(names[0] || "");
  return list(names) + " " + (many ? pluralForm : singular);
}

function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many || one + "s");
}

function ordinal(n) {
  var s = ["th", "st", "nd", "rd"];
  var v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** A stable pick from a list, so a redraw does not change what Rimshot says. */
function pick(items, seed) {
  var h = 0;
  var text = String(seed);
  for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return items[Math.abs(h) % items.length];
}

/** True the first time a key is seen: plays an entrance animation once, not on every redraw. */
var seenKeys = {};
function once(key) {
  if (seenKeys[key]) return false;
  seenKeys[key] = true;
  return true;
}

/** Animation delay that keeps a looping animation in phase across redraws. */
function phaseDelay(seconds) {
  return "-" + ((performance.now() / 1000) % seconds).toFixed(2) + "s";
}

// ---------- crews ----------

var CREW_TEXT = ["#FF7A70", "#7FB2FF", "#FFE27A", "#7EE09A", "#C4A6FF", "#FFB977", "#7EE8DC", "#FFD0E6"];

var INK = "#1A1230";
var S = 'stroke="' + INK + '" stroke-width="5"';
var R = 'stroke-linecap="round"';

// Each mascot: its body, its resting face, and where its face sits, so the
// same body can cheer, concentrate or sulk. Shape and colour both differ, so
// colour-blind players can tell the crews apart.
var MASCOTS = [
  {
    body:
      '<path d="M50 6 C63 30 84 44 84 64 C84 83 69 95 50 95 C31 95 16 83 16 64 C16 44 37 30 50 6 Z" fill="#FF5A4E" ' + S + ' stroke-linejoin="round"/>' +
      '<path d="M27 62 Q28 50 36 44" fill="none" stroke="#FFF6E3" stroke-width="4" ' + R + "/>",
    face: { cx: 51, ey: 64, dx: 10, my: 78 },
    rest: '<path d="M42 76 Q51 85 60 76" fill="none" ' + S + " " + R + "/>",
  },
  {
    body:
      '<circle cx="50" cy="57" r="37" fill="#3D8BFF" ' + S + "/>" +
      '<path d="M37 24 L41 10 L50 19 L59 10 L63 24 Z" fill="#2B5FCC" ' + S + ' stroke-linejoin="round"/>',
    face: { cx: 50, ey: 57, dx: 10, my: 72 },
    rest: '<path d="M40 70 Q50 80 60 70" fill="none" ' + S + " " + R + "/>",
  },
  {
    body:
      '<path d="M8 58 C8 36 28 24 50 24 C72 24 92 36 92 58 C92 80 72 92 50 92 C28 92 8 80 8 58 Z" fill="#FFD23F" ' + S + "/>" +
      '<path d="M50 24 Q56 6 74 8 Q67 24 50 24 Z" fill="#4CC36B" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>',
    face: { cx: 50, ey: 56, dx: 12, my: 72 },
    rest: '<circle cx="50" cy="72" r="6" fill="' + INK + '"/>',
  },
  {
    body:
      '<rect x="26" y="6" width="48" height="88" rx="24" fill="#4CC36B" ' + S + "/>" +
      '<circle cx="36" cy="26" r="3" fill="#2A8A45"/><circle cx="64" cy="34" r="3" fill="#2A8A45"/>' +
      '<circle cx="38" cy="78" r="3" fill="#2A8A45"/><circle cx="62" cy="84" r="3" fill="#2A8A45"/>',
    face: { cx: 50, ey: 46, dx: 8, my: 60 },
    rest: '<path d="M42 60 Q52 67 60 57" fill="none" ' + S + " " + R + "/>",
  },
  {
    body:
      '<path d="M50 24 L53 8" stroke="' + INK + '" stroke-width="6" ' + R + "/>" +
      '<circle cx="33" cy="38" r="15" fill="#A77BFF" ' + S + '/><circle cx="67" cy="38" r="15" fill="#A77BFF" ' + S + "/>" +
      '<circle cx="50" cy="34" r="15" fill="#A77BFF" ' + S + '/><circle cx="50" cy="80" r="14" fill="#A77BFF" ' + S + "/>" +
      '<circle cx="50" cy="58" r="20" fill="#A77BFF" ' + S + "/>",
    face: { cx: 50, ey: 56, dx: 7, my: 67 },
    rest: '<path d="M44 66 Q50 72 56 66" fill="none" ' + S + " " + R + "/>",
  },
  {
    body:
      '<circle cx="50" cy="58" r="36" fill="#FF9F43" ' + S + "/>" +
      '<path d="M50 22 Q60 6 76 12 Q66 26 50 22 Z" fill="#4CC36B" ' + S + ' stroke-linejoin="round"/>' +
      '<circle cx="30" cy="44" r="2.5" fill="#C96A14"/><circle cx="70" cy="76" r="2.5" fill="#C96A14"/>',
    face: { cx: 50, ey: 58, dx: 10, my: 72 },
    rest: '<path d="M38 70 Q50 84 62 70 Z" fill="' + INK + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>',
  },
  {
    body:
      '<path d="M50 6 C80 26 88 62 50 94 C12 62 20 26 50 6 Z" fill="#3FD6C6" ' + S + ' stroke-linejoin="round"/>' +
      '<path d="M50 18 V38 M50 72 V86" stroke="#1F9C8F" stroke-width="4" ' + R + "/>",
    face: { cx: 50, ey: 52, dx: 10, my: 64 },
    rest: '<path d="M42 63 Q50 70 58 63" fill="none" ' + S + " " + R + "/>",
  },
  {
    body:
      '<rect x="14" y="22" width="72" height="66" rx="24" fill="#FFB8D9" ' + S + "/>" +
      '<path d="M28 36 Q50 28 72 36" fill="none" stroke="#FFFFFF" stroke-width="5" ' + R + "/>",
    face: { cx: 50, ey: 56, dx: 10, my: 70 },
    rest: '<path d="M42 68 Q50 75 58 68" fill="none" ' + S + " " + R + "/>",
    restEyes: '<path d="M34 56 Q40 50 46 56 M54 56 Q60 50 66 56" fill="none" ' + S + " " + R + "/>",
  },
];

function eyes(f, kind) {
  var l = f.cx - f.dx;
  var r = f.cx + f.dx;
  if (kind === "arc") {
    return (
      '<path d="M' + (l - 6) + " " + (f.ey + 2) + " Q" + l + " " + (f.ey - 6) + " " + (l + 6) + " " + (f.ey + 2) +
      " M" + (r - 6) + " " + (f.ey + 2) + " Q" + r + " " + (f.ey - 6) + " " + (r + 6) + " " + (f.ey + 2) +
      '" fill="none" ' + S + " " + R + "/>"
    );
  }
  return '<circle cx="' + l + '" cy="' + f.ey + '" r="5" fill="' + INK + '"/><circle cx="' + r + '" cy="' + f.ey + '" r="5" fill="' + INK + '"/>';
}

/**
 * A crew's mascot as an <svg>. mood: "rest" (default), "cheer" (won), "focus"
 * (writing), "sulk" (lost).
 */
function mascot(team, size, mood, cls) {
  var m = MASCOTS[team % MASCOTS.length];
  var f = m.face;
  var face;
  if (mood === "cheer") {
    face =
      eyes(f, "arc") +
      '<path d="M' + (f.cx - 12) + " " + (f.my - 5) + " Q" + f.cx + " " + (f.my + 13) + " " + (f.cx + 12) + " " + (f.my - 5) +
      ' Z" fill="' + INK + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>';
  } else if (mood === "focus") {
    face = eyes(f) + '<path d="M' + (f.cx - 7) + " " + f.my + " L" + (f.cx + 7) + " " + f.my + '" ' + S + " " + R + "/>";
  } else if (mood === "sulk") {
    face =
      eyes(f) +
      '<path d="M' + (f.cx - 10) + " " + (f.my + 4) + " Q" + f.cx + " " + (f.my - 6) + " " + (f.cx + 10) + " " + (f.my + 4) +
      '" fill="none" ' + S + " " + R + "/>";
  } else {
    face = (m.restEyes || eyes(f)) + m.rest;
  }
  return art(
    '<svg class="mascot ' + (cls || "") + '" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      m.body + face + "</svg>",
  );
}

/** The crew colour class: sets --crew and --crew-text for anything inside. */
function crewClass(team) {
  return team === null || team === undefined ? "" : "c" + team;
}

/** A round "avatar" with a player's initial, in their crew's colour. */
function avatar(name, team, size) {
  return el(
    "span",
    { class: "avatar " + crewClass(team), style: size ? "--size:" + size + "px" : null, title: name },
    (name || "?").trim().charAt(0).toUpperCase() || "?",
  );
}

// ---------- Rimshot, the emcee ----------

var RIMSHOT =
  '<svg class="rimshot" viewBox="0 0 120 160" aria-hidden="true">' +
  '<rect x="47" y="86" width="26" height="62" rx="11" fill="#5B4A8F" ' + S + "/>" +
  '<rect x="36" y="80" width="48" height="14" rx="7" fill="#FFD23F" ' + S + "/>" +
  '<circle cx="60" cy="46" r="40" fill="#E4DDF5" ' + S + "/>" +
  '<path d="M28 30 Q60 16 92 30" fill="none" stroke="#B7AAD9" stroke-width="4" ' + R + "/>" +
  '<ellipse cx="46" cy="44" rx="5" ry="7" fill="' + INK + '"/><ellipse cx="74" cy="44" rx="5" ry="7" fill="' + INK + '"/>' +
  '<path d="M40 58 Q60 80 80 58 Z" fill="' + INK + '" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
  '<circle cx="34" cy="58" r="6" fill="#FF9EC7"/><circle cx="86" cy="58" r="6" fill="#FF9EC7"/>' +
  '<path d="M60 116 L44 106 L44 126 Z M60 116 L76 106 L76 126 Z" fill="#FF4F9A" stroke="' + INK + '" stroke-width="4" stroke-linejoin="round"/>' +
  '<circle cx="60" cy="116" r="5" fill="' + INK + '"/></svg>';

/** Rimshot and a speech bubble. `signed` adds the "RIMSHOT · YOUR EMCEE" credit. */
function emcee(line, opts) {
  opts = opts || {};
  var bot = art(RIMSHOT);
  bot.classList.add("bob");
  return el(
    "div",
    { class: "emcee " + (opts.cls || "") },
    bot,
    el(
      "div",
      { class: "bubble", id: opts.id || null },
      el("p", {}, line),
      opts.signed ? el("p", { class: "credit" }, "RIMSHOT · YOUR EMCEE") : null,
    ),
  );
}

var CREW_QUIPS = [
  "Hot Sauce has never once been mild.",
  "Blueberries: small, round, devastating.",
  "Lemons. Sharp, sour, slightly bitter. Perfect.",
  "Pickles are a big dill. Sorry. Not sorry.",
  "Grapes travel in bunches. Very on brand.",
  "Tangerines: zesty and slightly unhinged.",
  "Mints: refreshingly savage.",
  "Marshmallows look soft. Do not be fooled.",
];

var QUIPS = {
  write: [
    "Everybody's writing. Nobody's safe.",
    "All crews on deck. I've seen funnier silence, so make it count.",
    "Pens out, everyone. Lock yours in, then back a teammate's.",
  ],
  crewVote: [
    "Pens down! Five seconds to back your crew's best line.",
    "Writing's closed. Pick a teammate's answer, quick.",
  ],
  vote: [
    "Pick the one that made you snort. Honesty is mandatory.",
    "Votes are secret. Your face is not.",
    "Any answer but the one you wrote. Yes, your crew's counts.",
  ],
  voteTwo: [
    "Two votes each, two different answers. Spend them wisely.",
    "You get two picks. Not on the same answer, and not on your own.",
  ],
  generating: [
    "Hold the curtain! I'm writing tonight's material.",
    "One moment. Fresh jokes take at least a few seconds.",
    "I'm asking a very clever friend for prompts. Talk amongst yourselves.",
  ],
  idle: [
    "is staring at the ceiling",
    "is thinking very hard",
    "is pretending to think",
    "is chewing an imaginary pen",
    "is waiting for the muse",
  ],
};

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, function (_, key) {
    return values[key] === undefined ? "" : values[key];
  });
}

// ---------- clocks ----------

function clockText(ms) {
  var s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** Calls draw(msLeft, fractionLeft) every frame until the deadline, while `node` is on the page. */
function countdown(game, node, deadline, totalMs, draw) {
  function tick() {
    if (!node.isConnected) return;
    var left = Math.max(0, deadline - game.now());
    draw(left, Math.min(1, left / totalMs));
    if (left > 0) requestAnimationFrame(tick);
  }
  setTimeout(tick, 0);
}

// ---------- confetti ----------

var CONFETTI = ["#FFD23F", "#FF4F9A", "#3D8BFF", "#4CC36B", "#FF5A4E", "#FFF6E3", "#A77BFF"];

/** Drops a burst of confetti into `layer`, which should be a fixed, full-size overlay. */
function confetti(layer, count, height) {
  for (var i = 0; i < count; i++) {
    var piece = el("span", {
      class: "confetto",
      style:
        "left:" + (Math.random() * 100).toFixed(1) + "%;" +
        "width:" + (8 + (i % 3) * 6) + "px;" +
        "background:" + CONFETTI[i % CONFETTI.length] + ";" +
        "--fall:" + (height || 760) + "px;" +
        "--spin:" + (360 + Math.random() * 360).toFixed(0) + "deg;" +
        "animation-duration:" + (3 + Math.random() * 2.6).toFixed(2) + "s;" +
        "animation-delay:" + (Math.random() * 1.6).toFixed(2) + "s",
    });
    piece.addEventListener("animationend", function () {
      this.remove();
    });
    layer.append(piece);
  }
}

// ---------- text fitting ----------

/** Shrinks [data-fit] text until it fits its box. data-fit="min" sets the smallest size in px. */
function fitAll(root) {
  root.querySelectorAll("[data-fit]").forEach(function (node) {
    node.style.fontSize = "";
    var style = getComputedStyle(node);
    var size = parseFloat(style.fontSize);
    var min = Number(node.getAttribute("data-fit")) || 14;
    var tooBig = function () {
      // Chunky display glyphs poke out of their line boxes; allow for that.
      var limit = /px$/.test(style.maxHeight) ? parseFloat(style.maxHeight) : node.clientHeight;
      return node.scrollHeight > limit + size * 0.25 || node.scrollWidth > node.clientWidth + 2;
    };
    while (size > min && tooBig()) {
      size -= 2;
      node.style.fontSize = size + "px";
    }
  });
}

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(function () {
    var app = document.getElementById("app");
    if (app) fitAll(app);
  });
}

function showStatus(game) {
  game.onStatus(function (status) {
    var badge = document.getElementById("status");
    badge.hidden = status === "connected" || status === "connecting";
    badge.textContent =
      status === "replaced" ? "Opened on another device" : status === "closed" ? "Game closed" : "Reconnecting…";
  });
}
