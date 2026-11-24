// The phone page. It stays loaded for the whole party: it holds the lobby
// socket, and shows whichever game the host is running in an iframe.
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var store = {
    get: function (area, key) {
      try {
        return window[area].getItem(key);
      } catch (e) {
        return null;
      }
    },
    set: function (area, key, value) {
      try {
        if (value === null) window[area].removeItem(key);
        else window[area].setItem(key, value);
      } catch (e) {
        /* private mode: carry on without remembering */
      }
    },
  };

  var ERRORS = {
    bad_code: "No party with that code. Check the big screen.",
    full: "That party is full.",
    rate_limited: "Too many tries. Wait a minute and try again.",
  };

  var joined = null; // { code, name } once the player asked to join
  var state = null; // last snapshot from the hub
  var ws = null;
  var attempt = 0;
  var retryTimer = null;
  var shownLaunch = null; // launchId currently in the iframe
  var blockedLaunch = null; // a launch this phone could not get into
  var wakeLock = null;

  function show(id) {
    ["join", "lobby", "frame"].forEach(function (name) {
      $(name).hidden = name !== id;
    });
    $("bar").hidden = id === "join";
  }

  function render() {
    if (!joined) {
      dropGame();
      show("join");
      return;
    }
    if (!state) return;
    $("bar-code").textContent = state.code;
    $("bar-name").textContent = state.you ? state.you.name : "";
    $("me").textContent = state.you ? state.you.name : "";

    var game = state.game;
    if (game && game.status === "running" && game.launchId !== blockedLaunch) {
      if (shownLaunch !== game.launchId) {
        dropGame();
        // A new element each time, so games do not pile up in the back button.
        var frame = document.createElement("iframe");
        frame.allow = "screen-wake-lock; fullscreen; autoplay";
        frame.title = game.name;
        frame.src = game.url;
        $("frame").appendChild(frame);
        shownLaunch = game.launchId;
      }
      show("frame");
      return;
    }

    dropGame();
    $("lobby-hint").textContent =
      game && game.launchId === blockedLaunch
        ? "Could not join this game. It may be full. You're in for the next one."
        : game
          ? "Starting " + game.name + "…"
          : "Watch the big screen. The host is picking a game.";
    var list = $("players");
    list.textContent = "";
    state.players.forEach(function (player) {
      var item = document.createElement("li");
      item.textContent = player.name;
      if (!player.connected) item.className = "away";
      if (state.you && player.id === state.you.id) item.className = "me";
      list.appendChild(item);
    });
    show("lobby");
  }

  function dropGame() {
    $("frame").textContent = "";
    shownLaunch = null;
  }

  function leave(message) {
    joined = null;
    state = null;
    blockedLaunch = null;
    store.set("sessionStorage", "arcade.session", null);
    clearTimeout(retryTimer);
    if (ws) ws.close();
    $("banner").hidden = true;
    $("join-error").textContent = message || "";
    $("join-button").disabled = false;
    render();
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!joined || (ws && ws.readyState <= 1)) return;
    var socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/lobby");
    ws = socket;
    socket.onopen = function () {
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "player",
          code: joined.code,
          name: joined.name,
          device: store.get("localStorage", "arcade.device"),
        }),
      );
    };
    socket.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.type === "welcome") {
        attempt = 0;
        $("banner").hidden = true;
        store.set("localStorage", "arcade.device", message.device);
        store.set("sessionStorage", "arcade.session", JSON.stringify(joined));
        if (location.pathname !== "/" + message.code) history.replaceState(null, "", "/" + message.code);
      } else if (message.type === "state") {
        state = message;
        render();
      } else if (message.type === "error") {
        leave(ERRORS[message.code] || "Something went wrong. Try again.");
      } else if (message.type === "bye") {
        leave(message.reason === "host" ? "The host ended the party." : "The party is over.");
      }
    };
    socket.onclose = function () {
      if (ws !== socket) return;
      ws = null;
      if (!joined) return;
      $("banner").hidden = false;
      retryTimer = setTimeout(connect, Math.min(300 * Math.pow(2, attempt++), 5000));
    };
  }

  function keepAwake() {
    if (!navigator.wakeLock || wakeLock || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(
      function (lock) {
        wakeLock = lock;
        lock.addEventListener("release", function () {
          wakeLock = null;
        });
      },
      function () {},
    );
  }

  $("join-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var code = $("code").value.trim().toUpperCase();
    var name = $("name").value.trim();
    if (!code || !name) return;
    $("join-error").textContent = "";
    $("join-button").disabled = true;
    store.set("localStorage", "arcade.name", name);
    joined = { code: code, name: name };
    keepAwake();
    connect();
  });

  $("leave").addEventListener("click", function () {
    leave("");
  });

  // A game iframe says its ticket was refused (for example the game is full).
  window.addEventListener("message", function (event) {
    if (event.origin !== location.origin || !event.data || event.data.arcade !== "stale") return;
    if (!shownLaunch) return;
    blockedLaunch = shownLaunch;
    render();
  });

  // A phone waking up reconnects now instead of waiting out the backoff.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    keepAwake();
    if (joined && !ws) {
      attempt = 0;
      connect();
    }
  });
  window.addEventListener("online", connect);

  var pathCode = location.pathname.slice(1).toUpperCase();
  $("code").value = pathCode;
  $("name").value = store.get("localStorage", "arcade.name") || "";
  if (pathCode) $("name").focus();

  // A refresh mid-party goes straight back in.
  try {
    var resume = JSON.parse(store.get("sessionStorage", "arcade.session"));
    if (resume && resume.code && (!pathCode || pathCode === resume.code)) {
      joined = resume;
      connect();
    }
  } catch (e) {
    /* nothing to resume */
  }
  render();
})();
