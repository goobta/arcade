// Who may do what: the PIN gates the host screen, a signed cookie remembers
// the host, and a signed device token lets a phone keep its player id.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Fixed-window counter of failed attempts, e.g. "5 wrong PINs per 15 minutes
 * per address". Callers check allowed() first and take() on each failure, so
 * a whole party behind one home router is never locked out by succeeding.
 */
export class RateLimiter {
  #limit: number;
  #windowMs: number;
  #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** True while the key still has attempts left. Does not count as one. */
  allowed(key: string, now: number = Date.now()): boolean {
    const entry = this.#hits.get(key);
    return !entry || entry.resetAt <= now || entry.count < this.#limit;
  }

  /** Records an attempt. False when the key has used up its allowance. */
  take(key: string, now: number = Date.now()): boolean {
    if (this.#hits.size > 10_000) this.#prune(now);
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.#limit;
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#hits) if (entry.resetAt <= now) this.#hits.delete(key);
  }
}

const HOST_COOKIE = "arcade_host";
const HOST_TTL_MS = 12 * 3_600_000;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class Auth {
  #pin: Buffer;
  #secure: boolean;
  // Fresh at every boot and never derived from the PIN: a restart signs
  // everyone out, which is fine because sessions do not survive one either.
  #key = randomBytes(32);

  constructor(pin: string, options: { secureCookies: boolean }) {
    this.#pin = digest(pin);
    this.#secure = options.secureCookies;
  }

  checkPin(candidate: unknown): boolean {
    if (typeof candidate !== "string" || candidate.length > 256) return false;
    return timingSafeEqual(digest(candidate), this.#pin);
  }

  #sign(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("base64url");
  }

  #verified(token: string | undefined, prefix: string): string | null {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const value = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const wanted = Buffer.from(this.#sign(prefix + value));
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
    return value;
  }

  /** Value for a Set-Cookie header that marks this browser as the host. */
  hostCookie(now: number = Date.now()): string {
    const expires = String(now + HOST_TTL_MS);
    const token = `${expires}.${this.#sign("host:" + expires)}`;
    return this.#cookie(token, HOST_TTL_MS / 1000);
  }

  clearHostCookie(): string {
    return this.#cookie("", 0);
  }

  #cookie(value: string, maxAge: number): string {
    const parts = [`${HOST_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
    if (this.#secure) parts.push("Secure");
    return parts.join("; ");
  }

  isHost(cookieHeader: string | undefined, now: number = Date.now()): boolean {
    if (!cookieHeader) return false;
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0 || part.slice(0, eq).trim() !== HOST_COOKIE) continue;
      const expires = this.#verified(part.slice(eq + 1).trim(), "host:");
      if (expires && Number(expires) > now) return true;
    }
    return false;
  }

  /** A new player id, and the token a phone stores to claim it again. */
  issueDevice(): { playerId: string; token: string } {
    const playerId = "p" + randomBytes(9).toString("base64url");
    return { playerId, token: `${playerId}.${this.#sign("device:" + playerId)}` };
  }

  /** The player id a device token proves, or null. */
  verifyDevice(token: unknown): string | null {
    if (typeof token !== "string" || token.length > 200) return null;
    return this.#verified(token, "device:");
  }
}
