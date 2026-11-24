// Tiny DOM helper shared by the host and phone pages.
//   el("button", { class: "quiet", onclick: fn }, "Next")
function el(tag, props) {
  var node = document.createElement(tag);
  Object.keys(props || {}).forEach(function (key) {
    var value = props[key];
    if (value === null || value === undefined || value === false) return;
    if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
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

function mount(root, node) {
  root.replaceChildren(node);
}

// Keeps a countdown bar in step with a server deadline (epoch ms).
function countdown(game, bar, deadline, totalMs) {
  function tick() {
    if (!bar.isConnected) return;
    var left = Math.max(0, deadline - game.now());
    bar.style.width = Math.min(100, (left / totalMs) * 100) + "%";
    if (left > 0) requestAnimationFrame(tick);
  }
  tick();
}

function showStatus(game) {
  game.onStatus(function (status) {
    var badge = document.getElementById("status");
    badge.hidden = status === "connected" || status === "connecting";
    badge.textContent =
      status === "replaced" ? "Opened on another device" : status === "closed" ? "Game closed" : "Reconnecting…";
  });
}
