import assert from "node:assert/strict";
import { test } from "node:test";
import { signTicket, verifyTicket, type TicketClaims } from "../src/ticket.ts";

const SECRET = "launch-secret";
const NOW = 1_000_000;
const claims: TicketClaims = {
  v: 1, lid: "launch-1", code: "BCDF", gid: "trivia", pid: "p1", name: "Ada", role: "player", exp: NOW + 60_000,
};
const expect = { lid: "launch-1", code: "BCDF" };

test("a signed ticket verifies and returns its claims", () => {
  const ticket = signTicket(SECRET, claims);
  assert.deepEqual(verifyTicket(SECRET, ticket, expect, NOW), claims);
});

test("names with non-ASCII characters survive the round trip", () => {
  const ticket = signTicket(SECRET, { ...claims, name: "Zoë 🎲" });
  assert.equal(verifyTicket(SECRET, ticket, expect, NOW)?.name, "Zoë 🎲");
});

test("a ticket is refused when altered, expired, or for another launch", () => {
  const ticket = signTicket(SECRET, claims);
  const [payload, signature] = ticket.split(".");

  // Promote yourself to host by editing the payload.
  const forged = Buffer.from(JSON.stringify({ ...claims, role: "host" })).toString("base64url");
  assert.equal(verifyTicket(SECRET, `${forged}.${signature}`, expect, NOW), null);

  assert.equal(verifyTicket("other-secret", ticket, expect, NOW), null, "wrong secret");
  assert.equal(verifyTicket(SECRET, ticket, expect, NOW + 60_001), null, "expired");
  assert.equal(verifyTicket(SECRET, ticket, { lid: "launch-2", code: "BCDF" }, NOW), null, "other launch");
  assert.equal(verifyTicket(SECRET, ticket, { lid: "launch-1", code: "ZZZZ" }, NOW), null, "other party");
  assert.equal(verifyTicket(SECRET, payload, expect, NOW), null, "no signature");
  assert.equal(verifyTicket(SECRET, `${payload}.`, expect, NOW), null, "empty signature");
  assert.equal(verifyTicket(SECRET, `${ticket}.extra`, expect, NOW), null);
});

test("anything that is not a ticket is refused without throwing", () => {
  for (const junk of [undefined, null, "", "nope", 42, {}, [], "a.b", "x".repeat(5000)]) {
    assert.equal(verifyTicket(SECRET, junk, expect, NOW), null);
  }
});

test("a correctly signed ticket with a nonsense role is still refused", () => {
  const ticket = signTicket(SECRET, { ...claims, role: "admin" as "host" });
  assert.equal(verifyTicket(SECRET, ticket, expect, NOW), null);
});
