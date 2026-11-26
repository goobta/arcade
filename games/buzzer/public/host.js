var game = Arcade.connect();

// Called with the latest hostView() every time it changes.
game.onView(function (view) {
  document.getElementById("headline").textContent =
    view.phase === "open" ? "Buzz!" : view.phase === "won" ? view.winner + " got it!" : "Get ready…";
  document.getElementById("open").disabled = view.phase === "open";

  var list = document.getElementById("players");
  list.replaceChildren();
  view.players.forEach(function (player) {
    var item = document.createElement("li");
    item.textContent = player.name + " · " + player.score;
    if (!player.connected) item.className = "away";
    list.appendChild(item);
  });
});

document.getElementById("open").onclick = function () {
  game.send("open"); // runs onHost.open on the server
};
document.getElementById("exit").onclick = function () {
  game.send("exit");
};
