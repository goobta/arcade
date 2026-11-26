// Browser half of @arcade/sdk. Loaded by a game's host.html and play.html as
// ./_sdk/arcade.js, after Colyseus's client in the same file.
//
//   const game = Arcade.connect();
//   game.onView((view) => render(view));
//   game.send("answer", 2);
(function () {
  "use strict";

  var CLOSE_REPLACED = 4901;

  function readTicket() {
    var ticket = new URLSearchParams(location.hash.slice(1)).get("t") || "";
    var claims = null;
    try {
      var b64 = ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      var bytes = Uint8Array.from(atob(b64), function (c) {
        return c.charCodeAt(0);
      });
      claims = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      /* handled below */
    }
    return { ticket: ticket, claims: claims };
  }

  function tellHub(message) {
    if (window.parent !== window) window.parent.postMessage({ arcade: message }, location.origin);
  }

  function connect() {
    var id = readTicket();
    // Pages are served at <base>/host and <base>/play; the game server is <base>.
    var base = location.pathname.replace(/\/[^/]*$/, "");
    var client = new Colyseus.Client(location.origin + base);

    var room = null;
    var joining = false;
    var stopped = false;
    var attempt = 0;
    var retry = null;
    var clockOffset = 0;
    var lastView;
    var hasView = false;
    var status = "connecting";
    var viewHandlers = [];
    var statusHandlers = [];
    var messageHandlers = {};

    function setStatus(next) {
      if (next === status) return;
      status = next;
      statusHandlers.forEach(function (fn) {
        fn(next);
      });
    }

    function scheduleJoin() {
      if (stopped || retry) return;
      var delay = Math.min(250 * Math.pow(2, attempt), 4000);
      attempt += 1;
      retry = setTimeout(function () {
        retry = null;
        join();
      }, delay);
    }

    function join() {
      if (stopped || joining || room) return;
      if (!id.claims) {
        stopped = true;
        setStatus("closed");
        tellHub("stale");
        return;
      }
      joining = true;
      client.joinById(id.claims.code, { ticket: id.ticket }).then(
        function (joined) {
          joining = false;
          if (stopped) return joined.leave();
          room = joined;
          attempt = 0;
          // A fresh join with the ticket takes the seat back, and unlike
          // Colyseus's own reconnection it also survives a page reload.
          if (joined.reconnection) joined.reconnection.enabled = false;
          joined.onMessage("view", function (message) {
            clockOffset = message.t - Date.now();
            lastView = message.v;
            hasView = true;
            viewHandlers.forEach(function (fn) {
              fn(lastView);
            });
          });
          joined.onMessage("msg", function (message) {
            (messageHandlers[message.type] || []).forEach(function (fn) {
              fn(message.data);
            });
          });
          joined.onMessage("arcade:end", function () {
            tellHub("exit");
          });
          joined.onLeave(function (code) {
            if (room !== joined) return;
            room = null;
            if (code === CLOSE_REPLACED) {
              // This seat was opened in another tab or device.
              stopped = true;
              setStatus("replaced");
              return;
            }
            setStatus("reconnecting");
            scheduleJoin();
          });
          joined.onError(function () {});
          setStatus("connected");
        },
        function (error) {
          joining = false;
          var code = error && (error.code || error.status);
          if (code === 401 || code === 403) {
            // The ticket is no longer valid (game restarted, or full): let the
            // hub shell decide what to show instead of retrying forever.
            stopped = true;
            setStatus("closed");
            tellHub("stale");
            return;
          }
          setStatus("reconnecting");
          scheduleJoin();
        },
      );
    }

    // A phone that slept comes back with a dead socket it has not noticed yet.
    function wake() {
      if (stopped || document.visibilityState === "hidden") return;
      if (!room && !joining) {
        clearTimeout(retry);
        retry = null;
        attempt = 0;
        join();
      }
    }
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("online", wake);

    join();

    return {
      /** "host" or "player". */
      role: id.claims ? id.claims.role : null,
      /** This player's id and name, as the hub knows them. */
      me: id.claims ? { id: id.claims.pid, name: id.claims.name } : null,
      /** The room code. */
      code: id.claims ? id.claims.code : null,
      /** Called with every new view, and immediately if one already arrived. */
      onView: function (fn) {
        viewHandlers.push(fn);
        if (hasView) fn(lastView);
      },
      /** "connecting" | "connected" | "reconnecting" | "replaced" | "closed". */
      onStatus: function (fn) {
        statusHandlers.push(fn);
        fn(status);
      },
      /** One-off messages sent with game.send / game.broadcast on the server. */
      on: function (type, fn) {
        (messageHandlers[type] = messageHandlers[type] || []).push(fn);
      },
      /** Send an action to the server's onHost / onPlayer handler of that name. */
      send: function (type, data) {
        if (room) room.send("act", { type: type, data: data });
      },
      /** Server time in epoch ms: compare against deadlines in the view. */
      now: function () {
        return Date.now() + clockOffset;
      },
    };
  }

  window.Arcade = {
    connect: connect,
    /** Host only: close this game and go back to the game picker. */
    exit: function () {
      tellHub("exit");
    },
  };
})();
