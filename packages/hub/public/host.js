// The projector page: PIN gate, then the room code, who has joined, and the
// game picker. A running game is shown in an iframe under a thin join bar.
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };
  var session = {
    get: function () {
      try {
        return sessionStorage.getItem("arcade.host.code");
      } catch (e) {
        return null;
      }
    },
    set: function (code) {
      try {
        if (code) sessionStorage.setItem("arcade.host.code", code);
        else sessionStorage.removeItem("arcade.host.code");
      } catch (e) {
        /* carry on */
      }
    },
  };

  var ERRORS = {
    busy: "Another game is still running. Close it first, or try again in a moment.",
    unknown_game: "That game is no longer installed.",
    game_failed: "The game failed to start. Check the hub logs.",
    game_crashed: "The game crashed. Pick it again to restart.",
    too_many_sessions: "Too many parties are open right now.",
  };
  var NOTICES = {
    idle: "The game was closed because nobody was connected.",
    max_lifetime: "The game was closed after reaching its time limit.",
  };

  var ws = null;
  var open = false; // true once the PIN is accepted
  var state = null;
  var attempt = 0;
  var retryTimer = null;
  var shownLaunch = null;
  var toastTimer = null;
  var wakeLock = null;

  function toast(text) {
    $("toast").textContent = text;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      $("toast").hidden = true;
    }, 6000);
  }

  function view(id) {
    ["gate", "home", "stage"].forEach(function (name) {
      $(name).hidden = name !== id;
    });
  }

  function dropGame() {
    var frame = $("stage").querySelector("iframe");
    if (frame) frame.remove();
    shownLaunch = null;
  }

  function render() {
    if (!open) return view("gate");
    if (!state) return;

    var game = state.game;
    if (game) {
      $("bar-game").textContent = game.name;
      if (game.status === "running") {
        $("starting").hidden = true;
        if (shownLaunch !== game.launchId) {
          dropGame();
          var frame = document.createElement("iframe");
          frame.allow = "fullscreen; autoplay; screen-wake-lock";
          frame.title = game.name;
          frame.src = game.url;
          $("stage").appendChild(frame);
          shownLaunch = game.launchId;
        }
      } else {
        dropGame();
        $("starting-name").textContent = game.name;
        $("starting").hidden = false;
      }
      return view("stage");
    }

    dropGame();
    var list = $("players");
    list.textContent = "";
    state.players.forEach(function (player) {
      var item = document.createElement("li");
      item.textContent = player.name;
      if (!player.connected) item.className = "away";
      list.appendChild(item);
    });
    $("player-count").textContent = state.players.length ? "(" + state.players.length + ")" : "";
    view("home");
  }

  function loadGames() {
    fetch("/api/games")
      .then(function (response) {
        return response.json();
      })
      .then(function (body) {
        var grid = $("games");
        grid.textContent = "";
        (body.games || []).forEach(function (game) {
          var card = document.createElement("button");
          card.className = "card";
          card.type = "button";
          card.dataset.game = game.id;
          var thumb = document.createElement(game.thumbnail ? "img" : "div");
          thumb.className = "thumb";
          if (game.thumbnail) {
            thumb.src = game.thumbnail;
            thumb.alt = "";
          }
          var title = document.createElement("span");
          title.className = "title";
          title.textContent = game.name;
          var blurb = document.createElement("span");
          blurb.className = "blurb";
          blurb.textContent = game.blurb;
          var meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent =
            game.minPlayers === game.maxPlayers
              ? game.minPlayers + " players"
              : game.minPlayers + "–" + game.maxPlayers + " players";
          card.append(thumb, title, blurb, meta);
          card.addEventListener("click", function () {
            send({ type: "launch", gameId: game.id });
          });
          grid.appendChild(card);
        });
      })
      .catch(function () {});
  }

  function send(message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function connect() {
    clearTimeout(retryTimer);
    if (!open || (ws && ws.readyState <= 1)) return;
    var socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/lobby");
    ws = socket;
    socket.onopen = function () {
      socket.send(JSON.stringify({ type: "hello", role: "host", code: session.get() }));
    };
    socket.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.type === "welcome") {
        attempt = 0;
        session.set(message.code);
        var host = new URL(message.joinUrl).host;
        $("join-host").textContent = host;
        $("bar-host").textContent = host;
        $("room-code").textContent = message.code;
        $("bar-code").textContent = message.code;
        $("qr").src = "/api/qr.svg?code=" + message.code;
        loadGames();
      } else if (message.type === "state") {
        var hadGame = state && state.game;
        state = message;
        if (hadGame && !state.game) loadGames(); // pick up games added meanwhile
        render();
      } else if (message.type === "error") {
        if (message.code === "not_host") {
          open = false;
          render();
        } else {
          toast(ERRORS[message.code] || "Something went wrong.");
        }
      } else if (message.type === "notice") {
        toast(NOTICES[message.code] || "");
      } else if (message.type === "bye") {
        session.set(null);
        state = null;
      }
    };
    socket.onclose = function () {
      if (ws !== socket) return;
      ws = null;
      if (!open) return;
      retryTimer = setTimeout(connect, Math.min(300 * Math.pow(2, attempt++), 5000));
    };
  }

  function start() {
    open = true;
    keepAwake();
    connect();
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

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  }

  $("pin-form").addEventListener("submit", function (event) {
    event.preventDefault();
    $("pin-error").textContent = "";
    fetch("/api/host/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: $("pin").value }),
    })
      .then(function (response) {
        if (response.ok) {
          $("pin").value = "";
          return start();
        }
        $("pin-error").textContent =
          response.status === 429 ? "Too many tries. Wait 15 minutes." : "That PIN is not right.";
      })
      .catch(function () {
        $("pin-error").textContent = "Could not reach the arcade.";
      });
  });

  $("close-game").addEventListener("click", function () {
    send({ type: "close" });
  });
  $("end").addEventListener("click", function () {
    if (!confirm("End the party? Everyone will be disconnected.")) return;
    send({ type: "end" });
    // The next connection starts a fresh party with a new code.
    setTimeout(connect, 300);
  });
  $("fullscreen").addEventListener("click", fullscreen);
  $("stage-fullscreen").addEventListener("click", fullscreen);

  // The game asks to be closed (its own "back to arcade" button, or game over).
  window.addEventListener("message", function (event) {
    if (event.origin !== location.origin || !event.data) return;
    if (event.data.arcade === "exit") send({ type: "close" });
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    keepAwake();
    if (open && !ws) connect();
  });

  fetch("/api/host/me")
    .then(function (response) {
      return response.json();
    })
    .then(function (body) {
      if (body.host) start();
      else render();
    })
    .catch(render);
})();
