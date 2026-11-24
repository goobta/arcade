var game = Arcade.connect();

// Called with this phone's playerView() every time it changes.
game.onView(function (view) {
  document.getElementById("score").textContent = game.me.name + " · " + view.score + " points";
  document.getElementById("buzz").disabled = view.phase !== "open";
  document.getElementById("note").textContent =
    view.phase === "won" ? (view.youWon ? "You got it!" : "Too slow!") : view.phase === "open" ? "" : "Wait for it…";
});

document.getElementById("buzz").onclick = function () {
  game.send("buzz"); // runs onPlayer.buzz on the server
};
