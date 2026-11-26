import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth, RateLimiter } from "../src/auth.ts";

const cookieValue = (setCookie: string): string => setCookie.split(";")[0];

test("only the exact PIN is accepted", () => {
  const auth = new Auth("correct-horse", { secureCookies: false });
  assert.equal(auth.checkPin("correct-horse"), true);
  assert.equal(auth.checkPin("correct-hors"), false);
  assert.equal(auth.checkPin("correct-horse "), false);
  assert.equal(auth.checkPin(""), false);
  assert.equal(auth.checkPin(undefined), false);
  assert.equal(auth.checkPin(12345678), false);
  assert.equal(auth.checkPin("x".repeat(10_000)), false);
});

test("the host cookie is accepted until it expires", () => {
  const auth = new Auth("correct-horse", { secureCookies: false });
  const now = 1_000_000;
  const cookie = cookieValue(auth.hostCookie(now));
  assert.equal(auth.isHost(cookie, now), true);
  assert.equal(auth.isHost(`other=1; ${cookie}; more=2`, now), true);
  assert.equal(auth.isHost(cookie, now + 12 * 3_600_000 - 1), true);
  assert.equal(auth.isHost(cookie, now + 12 * 3_600_000 + 1), false);
});

test("a forged or altered host cookie is refused", () => {
  const auth = new Auth("correct-horse", { secureCookies: false });
  const now = 1_000_000;
  const [name, token] = cookieValue(auth.hostCookie(now)).split("=");
  const [expires, signature] = token.split(".");

  assert.equal(auth.isHost(undefined), false);
  assert.equal(auth.isHost(`${name}=`), false);
  assert.equal(auth.isHost(`${name}=${Number(expires) + 99999}.${signature}`, now), false, "extended expiry");
  assert.equal(auth.isHost(`${name}=${expires}.${signature.slice(0, -2)}AA`, now), false, "altered signature");
  // A cookie from another hub instance (different boot key) does not carry over.
  const other = new Auth("correct-horse", { secureCookies: false });
  assert.equal(auth.isHost(cookieValue(other.hostCookie(now)), now), false);
});

test("cookie flags", () => {
  const plain = new Auth("correct-horse", { secureCookies: false }).hostCookie();
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Strict/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(new Auth("correct-horse", { secureCookies: true }).hostCookie(), /; Secure/);
  assert.match(new Auth("correct-horse", { secureCookies: false }).clearHostCookie(), /Max-Age=0/);
});

test("a device token proves its player id and nothing else", () => {
  const auth = new Auth("correct-horse", { secureCookies: false });
  const a = auth.issueDevice();
  const b = auth.issueDevice();
  assert.notEqual(a.playerId, b.playerId);
  assert.equal(auth.verifyDevice(a.token), a.playerId);
  // Swapping in another player's id invalidates the signature.
  const signature = a.token.slice(a.token.lastIndexOf("."));
  assert.equal(auth.verifyDevice(b.playerId + signature), null);
  assert.equal(auth.verifyDevice("garbage"), null);
  assert.equal(auth.verifyDevice(null), null);
  // A host cookie's signature cannot be replayed as a device token.
  const hostToken = cookieValue(auth.hostCookie()).split("=")[1];
  assert.equal(auth.verifyDevice(hostToken), null);
});

test("the rate limiter allows the limit, then refuses until the window passes", () => {
  const limiter = new RateLimiter(3, 1000);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => limiter.take("a", 0)), [true, true, true, false, false]);
  assert.equal(limiter.take("b", 0), true, "keys are independent");
  assert.equal(limiter.take("a", 999), false);
  assert.equal(limiter.take("a", 1000), true, "a new window starts");
});

test("allowed() reports the allowance without using it up", () => {
  const limiter = new RateLimiter(2, 1000);
  assert.equal(limiter.allowed("a", 0), true);
  assert.equal(limiter.allowed("a", 0), true, "asking is free");
  limiter.take("a", 0);
  assert.equal(limiter.allowed("a", 0), true);
  limiter.take("a", 0);
  assert.equal(limiter.allowed("a", 0), false, "two failures used the allowance");
  assert.equal(limiter.allowed("a", 1000), true);
});
