// A stand-in game for hub tests: speaks the process contract (PORT, /healthz,
// SIGTERM) without the SDK, and misbehaves on request.
//   node server.mjs <ok|slow|never-healthy|crasher|stubborn|exits-early>
import http from "node:http";
import { WebSocketServer } from "ws";

const mode = process.argv[2] ?? "ok";
if (mode === "exits-early") process.exit(2);

const bornAt = Date.now();
const healthy = () => {
  if (mode === "never-healthy") return false;
  if (mode === "slow") return Date.now() - bornAt > 600;
  return true;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://game");
  if (url.pathname === "/healthz") {
    res.writeHead(healthy() ? 200 : 503).end(healthy() ? "ok" : "starting");
  } else if (url.pathname === "/env") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(process.env));
  } else if (url.pathname === "/echo") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(req.url);
  } else if (url.pathname === "/host" || url.pathname === "/play") {
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>${mode}</title><p id="page">${url.pathname}</p>`);
  } else if (url.pathname === "/crash") {
    res.writeHead(200).end("bye");
    setTimeout(() => process.exit(1), 20);
  } else {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket, req) => {
  socket.send(`hello ${req.url}`);
  socket.on("message", (data) => socket.send(`echo ${data}`));
});

server.listen(Number(process.env.PORT), process.env.HOST);
if (mode === "crasher") setTimeout(() => process.exit(1), 700);
if (mode === "stubborn") process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
else process.on("SIGTERM", () => process.exit(0));
