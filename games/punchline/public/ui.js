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
  var set = (look() && look().mascots) || MASCOTS;
  var m = set[team % set.length];
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
  var bot = art((look() && look().rimshot) || RIMSHOT);
  bot.classList.add("bob");
  return el(
    "div",
    { class: "emcee " + (opts.cls || "") },
    bot,
    el(
      "div",
      { class: "bubble", id: opts.id || null },
      el("p", {}, line),
      opts.signed ? el("p", { class: "credit" }, say("credit", "RIMSHOT · YOUR EMCEE")) : null,
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
  var colours = (look() && look().confetti) || CONFETTI;
  for (var i = 0; i < count; i++) {
    var piece = el("span", {
      class: "confetto",
      style:
        "left:" + (Math.random() * 100).toFixed(1) + "%;" +
        "width:" + (8 + (i % 3) * 6) + "px;" +
        "background:" + colours[i % colours.length] + ";" +
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

// ---------- looks ----------
//
// A question pack can dress the whole show: its "theme" arrives as view.theme
// and names an entry here. A look swaps the mascots, the emcee, some copy and
// (through body[data-look] in style.css) the colours. With no look, or one
// this page does not know, everything above is used as it is.

var currentLook = null;

/** Call with view.theme on every view. Returns true when the look changed. */
function setLook(name) {
  var next = name && Object.prototype.hasOwnProperty.call(LOOKS, name) ? name : null;
  if (next === currentLook) return false;
  currentLook = next;
  if (next) document.body.setAttribute("data-look", next);
  else document.body.removeAttribute("data-look");
  return true;
}

function look() {
  return currentLook ? LOOKS[currentLook] : null;
}

/** A piece of copy: the look's wording for `key` if it has one, else `fallback`. */
function say(key, fallback) {
  var l = look();
  return l && l.text[key] !== undefined ? l.text[key] : fallback;
}

/** Rimshot's lines for a moment, in the current look. */
function quips(key) {
  var l = look();
  return (l && l.quips[key]) || QUIPS[key];
}

function crewQuip(team) {
  var l = look();
  return ((l && l.crewQuips) || CREW_QUIPS)[team];
}

/** What a heckle is called on screen. The server always hears the plain kind. */
function heckleLabel(kind) {
  var l = look();
  return (l && l.heckles[kind]) || kind;
}

/** A decoration from the current look ("troupe", "dancerLeft", ...), or null without one. */
function lookArt(name, cls) {
  var l = look();
  if (!l || !l.art[name]) return null;
  var node = art(l.art[name]);
  if (cls) node.classList.add.apply(node.classList, cls.split(" "));
  return node;
}

// Raju's 60th: a wedding-tent night. Indian sweets for crews, Rimshot in a
// turban, dancers in saris and a pair of tablas.
var RJ_INK = "#2A0E24";
var RJ_S = 'stroke="' + RJ_INK + '" stroke-width="5"';

/** A dancer in a sari. `up` raises both arms; `flip` faces her the other way. */
function rjDancer(c, up, flip) {
  var arm = function (d) {
    return (
      '<path d="' + d + '" fill="none" stroke="' + RJ_INK + '" stroke-width="15" ' + R + "/>" +
      '<path d="' + d + '" fill="none" stroke="' + c.skin + '" stroke-width="7" ' + R + "/>"
    );
  };
  var bun = up ? 'cx="60" cy="14" r="9"' : 'cx="38" cy="24" r="10"';
  var body =
    arm("M72 66 Q98 58 92 26") +
    '<path d="M87 42 L98 40 M88 48 L99 47" fill="none" stroke="' + c.bangle + '" stroke-width="3"/>' +
    (up
      ? arm("M48 66 Q24 56 28 26") + '<path d="M22 40 L33 42 M21 47 L32 48" fill="none" stroke="' + c.bangle + '" stroke-width="3"/>'
      : arm("M48 66 Q22 82 42 98")) +
    '<path d="M44 88 C36 120 24 150 18 184 Q60 197 102 184 C96 150 84 120 76 88 Z" fill="' + c.sari + '" ' + RJ_S + ' stroke-linejoin="round"/>' +
    '<path d="M22 170 Q60 183 98 170" fill="none" stroke="' + c.border + '" stroke-width="8"/>' +
    '<path d="M60 98 L58 166 M50 102 L42 162 M70 102 L78 162" fill="none" stroke="' + c.pleat + '" stroke-width="3" ' + R + "/>" +
    '<path d="M46 60 H74 L77 90 H43 Z" fill="' + c.blouse + '" ' + RJ_S + ' stroke-linejoin="round"/>' +
    '<path d="M79 93 L46 58 L35 63 Q24 92 31 125 L44 119 Q40 96 47 80 L66 99 Z" fill="' + c.pallu + '" ' + RJ_S + ' stroke-linejoin="round"/>' +
    "<circle " + bun + ' fill="' + RJ_INK + '"/>' +
    "<circle " + bun + ' fill="none" stroke="' + c.flowers + '" stroke-width="4" stroke-dasharray="0.1 7" ' + R + "/>" +
    '<circle cx="60" cy="38" r="21" fill="' + c.skin + '" ' + RJ_S + "/>" +
    '<path d="M38 38 Q40 14 60 15 Q80 14 82 38 Q72 24 60 26 Q48 24 38 38 Z" fill="' + RJ_INK + '"/>' +
    '<circle cx="60" cy="32" r="3" fill="#E0153F"/>' +
    '<path d="M47 42 Q51 37 55 42 M65 42 Q69 37 73 42' + (up ? "" : " M52 48 Q60 56 68 48") + '" fill="none" stroke="' + RJ_INK + '" stroke-width="3" ' + R + "/>" +
    (up ? '<path d="M51 47 Q60 60 69 47 Z" fill="' + RJ_INK + '" stroke="' + RJ_INK + '" stroke-width="2" stroke-linejoin="round"/>' : "") +
    '<circle cx="39" cy="47" r="4" fill="#FFB01F" stroke="' + RJ_INK + '" stroke-width="2"/>' +
    '<circle cx="81" cy="47" r="4" fill="#FFB01F" stroke="' + RJ_INK + '" stroke-width="2"/>';
  return (
    '<svg class="dancer" viewBox="0 0 120 200" aria-hidden="true">' +
    (flip ? '<g transform="translate(120 0) scale(-1 1)">' + body + "</g>" : body) +
    "</svg>"
  );
}

var RJ_TEAL = { skin: "#C98A5A", sari: "#12B5A6", pleat: "#0B7F7A", pallu: "#7FE5DA", blouse: "#E0157A", border: "#FFB01F", bangle: "#FFB01F", flowers: "#FFF3D6" };
var RJ_SAFFRON = { skin: "#A86B3F", sari: "#FF7A1A", pleat: "#C9540A", pallu: "#FFC27A", blouse: "#7B2FBE", border: "#E0157A", bangle: "#12B5A6", flowers: "#FFB01F" };

var RJ_TABLA =
  '<svg class="tabla" viewBox="0 0 200 124" aria-hidden="true">' +
  '<ellipse cx="55" cy="110" rx="36" ry="9" fill="#E0157A" stroke="' + RJ_INK + '" stroke-width="4"/>' +
  '<path d="M12 50 Q8 106 55 110 Q102 106 98 50 Z" fill="#D9853B" ' + RJ_S + ' stroke-linejoin="round"/>' +
  '<path d="M22 60 L40 106 M40 64 L55 108 M70 64 L55 108 M88 60 L70 106" fill="none" stroke="#FFF3D6" stroke-width="3" ' + R + "/>" +
  '<ellipse cx="55" cy="48" rx="43" ry="15" fill="#FFF3D6" ' + RJ_S + "/>" +
  '<ellipse cx="63" cy="48" rx="16" ry="6" fill="' + RJ_INK + '"/>' +
  '<ellipse cx="150" cy="110" rx="27" ry="8" fill="#12B5A6" stroke="' + RJ_INK + '" stroke-width="4"/>' +
  '<path d="M121 40 Q114 104 150 110 Q186 104 179 40 Z" fill="#8A4B2A" ' + RJ_S + ' stroke-linejoin="round"/>' +
  '<path d="M128 50 L140 106 M143 54 L150 108 M157 54 L150 108 M172 50 L160 106" fill="none" stroke="#FFF3D6" stroke-width="3" ' + R + "/>" +
  '<ellipse cx="150" cy="38" rx="29" ry="11" fill="#FFF3D6" ' + RJ_S + "/>" +
  '<ellipse cx="150" cy="38" rx="12" ry="4.5" fill="' + RJ_INK + '"/>' +
  '<path d="M104 22 L110 8 M114 26 L124 14 M96 26 L92 12" fill="none" stroke="#FFB01F" stroke-width="4" ' + R + "/></svg>";

/** The tent's scalloped edge with marigold garlands, for the 1280px projector stage. */
var RJ_CANOPY = (function () {
  var swags = "M0 18";
  for (var x = 0; x < 1280; x += 160) swags += " Q" + (x + 80) + " 54 " + (x + 160) + " 18";
  return (
    '<svg class="canopy" viewBox="0 0 1280 46" width="1280" height="46" aria-hidden="true">' +
    '<defs><pattern id="rj-scallop" width="80" height="26" patternUnits="userSpaceOnUse">' +
    '<path d="M0 -4 H40 V4 A20 18 0 0 1 0 4 Z" fill="#FFB01F" stroke="' + RJ_INK + '" stroke-width="3"/>' +
    '<path d="M40 -4 H80 V4 A20 18 0 0 1 40 4 Z" fill="#12B5A6" stroke="' + RJ_INK + '" stroke-width="3"/>' +
    '</pattern></defs><rect width="1280" height="26" fill="url(#rj-scallop)"/>' +
    '<path d="' + swags + '" fill="none" stroke="#FF7A1A" stroke-width="10" ' + R + ' stroke-dasharray="0.1 12"/>' +
    '<path d="' + swags + '" fill="none" stroke="#FFC533" stroke-width="10" ' + R + ' stroke-dasharray="0.1 12" stroke-dashoffset="6"/></svg>'
  );
})();

var LOOKS = {
  raju60: {
    mascots: [
      {
        // Gulab jamun, in its bowl
        body:
          '<ellipse cx="50" cy="44" rx="35" ry="32" fill="#FF5A4E" ' + RJ_S + "/>" +
          '<path d="M27 32 Q32 20 44 17" fill="none" stroke="#FFF3D6" stroke-width="4" ' + R + "/>" +
          '<path d="M10 68 H90 Q86 96 50 96 Q14 96 10 68 Z" fill="#FFF3D6" ' + RJ_S + ' stroke-linejoin="round"/>' +
          '<path d="M18 80 Q50 91 82 80" fill="none" stroke="#12B5A6" stroke-width="4" ' + R + "/>",
        face: { cx: 50, ey: 40, dx: 10, my: 52 },
        rest: '<path d="M41 50 Q50 59 59 50" fill="none" ' + RJ_S + " " + R + "/>",
      },
      {
        // Kulfi on a stick
        body:
          '<rect x="44" y="66" width="12" height="30" rx="5" fill="#E8C48A" ' + RJ_S + "/>" +
          '<path d="M32 16 Q50 0 68 16 L76 68 Q50 80 24 68 Z" fill="#3D8BFF" ' + RJ_S + ' stroke-linejoin="round"/>' +
          '<path d="M36 24 Q40 16 48 13" fill="none" stroke="#FFF3D6" stroke-width="4" ' + R + "/>",
        face: { cx: 50, ey: 40, dx: 9, my: 54 },
        rest: '<path d="M41 52 Q50 62 59 52" fill="none" ' + RJ_S + " " + R + "/>",
      },
      {
        // Ladoo, with a sliver of pista
        body:
          '<circle cx="50" cy="57" r="37" fill="#FFD23F" ' + RJ_S + "/>" +
          '<circle cx="27" cy="46" r="3" fill="#D99A00"/><circle cx="73" cy="44" r="3" fill="#D99A00"/>' +
          '<circle cx="23" cy="66" r="3" fill="#D99A00"/><circle cx="77" cy="67" r="3" fill="#D99A00"/>' +
          '<circle cx="39" cy="85" r="3" fill="#D99A00"/><circle cx="63" cy="86" r="3" fill="#D99A00"/>' +
          '<path d="M39 21 Q50 8 61 21 Q50 28 39 21 Z" fill="#4CC36B" stroke="' + RJ_INK + '" stroke-width="4" stroke-linejoin="round"/>',
        face: { cx: 50, ey: 54, dx: 12, my: 70 },
        rest: '<circle cx="50" cy="70" r="6" fill="' + RJ_INK + '"/>',
      },
      {
        // Pista barfi, cut in a diamond
        body:
          '<path d="M50 8 L92 52 L50 96 L8 52 Z" fill="#4CC36B" ' + RJ_S + ' stroke-linejoin="round"/>' +
          '<path d="M48 22 L26 45" fill="none" stroke="#FFF3D6" stroke-width="4" ' + R + "/>" +
          '<circle cx="68" cy="38" r="3" fill="#2A8A45"/><circle cx="34" cy="74" r="3" fill="#2A8A45"/><circle cx="64" cy="78" r="3" fill="#2A8A45"/>',
        face: { cx: 50, ey: 52, dx: 10, my: 65 },
        rest: '<path d="M41 63 Q50 72 59 63" fill="none" ' + RJ_S + " " + R + "/>",
      },
      {
        // Falooda, in a tall glass
        body:
          '<rect x="33" y="88" width="34" height="8" rx="4" fill="#FFF3D6" stroke="' + RJ_INK + '" stroke-width="4"/>' +
          '<path d="M64 6 L55 30" fill="none" stroke="' + RJ_INK + '" stroke-width="9" ' + R + "/>" +
          '<path d="M64 6 L55 30" fill="none" stroke="#12B5A6" stroke-width="4" ' + R + "/>" +
          '<circle cx="46" cy="24" r="15" fill="#FFB8D9" ' + RJ_S + "/>" +
          '<path d="M26 30 H74 L65 90 H35 Z" fill="#A77BFF" ' + RJ_S + ' stroke-linejoin="round"/>',
        face: { cx: 50, ey: 54, dx: 8, my: 68 },
        rest: '<path d="M42 66 Q50 74 58 66" fill="none" ' + RJ_S + " " + R + "/>",
      },
      {
        // Jalebi
        body:
          '<circle cx="50" cy="52" r="40" fill="#FF9F43" ' + RJ_S + "/>" +
          '<path d="M50 30 C66 28 76 40 75 55 C74 72 58 80 44 78 C28 75 22 60 27 46" fill="none" stroke="#C9540A" stroke-width="5" ' + R + "/>",
        face: { cx: 50, ey: 50, dx: 11, my: 64 },
        rest: '<path d="M42 62 Q50 70 58 62" fill="none" ' + RJ_S + " " + R + "/>",
      },
    ],
    rimshot:
      '<svg class="rimshot" viewBox="0 -10 124 170" aria-hidden="true">' +
      '<rect x="47" y="86" width="26" height="62" rx="11" fill="#0B7F7A" ' + RJ_S + "/>" +
      '<rect x="36" y="80" width="48" height="14" rx="7" fill="#FFB01F" ' + RJ_S + "/>" +
      '<circle cx="60" cy="46" r="40" fill="#F6E7C8" ' + RJ_S + "/>" +
      '<ellipse cx="46" cy="46" rx="5" ry="7" fill="' + RJ_INK + '"/><ellipse cx="74" cy="46" rx="5" ry="7" fill="' + RJ_INK + '"/>' +
      '<circle cx="30" cy="58" r="6" fill="#FF9EC7"/><circle cx="90" cy="58" r="6" fill="#FF9EC7"/>' +
      '<path d="M52 70 Q60 80 68 70 Z" fill="' + RJ_INK + '" stroke="' + RJ_INK + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M60 62 C54 55 43 55 34 64 C39 61 44 63 46 66 C52 70 58 68 60 64 C62 68 68 70 74 66 C76 63 81 61 86 64 C77 55 66 55 60 62 Z" fill="' + RJ_INK + '" stroke="' + RJ_INK + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M98 30 Q114 42 106 62 L97 56 Q101 44 92 36 Z" fill="#FF7A1A" stroke="' + RJ_INK + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M19 36 C14 6 42 -7 62 -6 C86 -6 106 8 101 36 C80 22 40 22 19 36 Z" fill="#FF7A1A" ' + RJ_S + ' stroke-linejoin="round"/>' +
      '<path d="M28 22 Q60 2 94 20 M40 9 Q62 -2 84 7" fill="none" stroke="#C9540A" stroke-width="4" ' + R + "/>" +
      '<circle cx="60" cy="14" r="6" fill="#12B5A6" stroke="' + RJ_INK + '" stroke-width="3"/>' +
      '<path d="M60 116 L44 106 L44 126 Z M60 116 L76 106 L76 126 Z" fill="#E0157A" stroke="' + RJ_INK + '" stroke-width="4" stroke-linejoin="round"/>' +
      '<circle cx="60" cy="116" r="5" fill="' + RJ_INK + '"/></svg>',
    art: {
      canopy: RJ_CANOPY,
      troupe: '<div class="troupe">' + rjDancer(RJ_TEAL, false, false) + RJ_TABLA + rjDancer(RJ_SAFFRON, false, true) + "</div>",
      dancerLeft: rjDancer(RJ_TEAL, false, false),
      dancerRight: rjDancer(RJ_SAFFRON, false, true),
      cheer: '<div class="troupe cheer">' + rjDancer(RJ_TEAL, true, false) + RJ_TABLA + rjDancer(RJ_SAFFRON, true, true) + "</div>",
    },
    confetti: ["#FF7A1A", "#FFC533", "#FF7A1A", "#FFC533", "#12B5A6", "#E0157A", "#FFF3D6"],
    text: {
      title: "RAJU'S 60TH",
      tagline: "A Punchline birthday special",
      credit: "RIMSHOT JI · YOUR EMCEE",
      start: "Chalo, let's go!",
      zing: "WAH WAH!",
      encore: "Once more!",
      finalKicker: "FINAL BOWS · HAPPY 60TH, RAJU UNCLE!",
      billing: ["Stars of the sangeet", "Still get cake", "On dishes duty"],
      zingerAward: "BIGGEST WAH-WAH",
      cricketsAward: "THE PIN-DROP AWARD",
      crickets: "Arre yaar. Pin-drop silence.",
      placeholder: "Make uncle proud",
      lobbyEmpty: "Arre, phones out! The code's up there. Join before the cake is cut.",
      lobbyChoosing: "Pick your mithai! Anyone still dithering when we start joins the smallest crew.",
      lobbyReady: ["Crews are set. Chai is poured. Hit the big button when you're ready.", "Everyone's here. Raju Uncle, brace yourself."],
      pickHint: "Tap another sweet any time before the show starts.",
    },
    quips: {
      write: [
        "No pressure, beta. Raju Uncle is only judging you silently.",
        "Write like the whole family is watching. Because they are.",
        "Lock yours in, then back a teammate's. Chalo, chalo!",
      ],
      crewVote: ["Pens down! Five seconds to back your crew's best line.", "Bas, writing's closed. Pick a teammate's answer, jaldi!"],
      vote: [
        "Vote with your heart, not your family WhatsApp group.",
        "Votes are secret. Aunty's face is not.",
        "Any answer but the one you wrote. Yes, your crew's counts.",
      ],
      voteTwo: ["Two votes each, two different answers. Spend them wisely, beta.", "You get two picks. Not on the same answer, and not on your own."],
      idle: ["is still on a second samosa", "is thinking very hard", "is pretending to think", "is asking what the question was", "is waiting for chai"],
    },
    crewQuips: [
      "Gulab Jamuns: soft, sweet, and soaked in confidence.",
      "Kulfis stay cool under pressure.",
      "Ladoos: round, golden, impossible to stop at one.",
      "Barfis. Sharp corners, sharper jokes.",
      "Faloodas have layers. So many layers.",
      "Jalebis: twisted, in the best way.",
    ],
    heckles: { "HA!": "HAHA!", OOF: "ARRE!", WOW: "WAH!", "*clap*": "*taali*", BOO: "CHEE!", zzz: "zzz" },
  },
};
