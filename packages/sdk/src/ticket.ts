// Tickets are how the hub tells a game who is connecting.
//
// The hub mints one per player per launch and puts it in the game page's URL
// fragment. The game verifies it with the per-launch secret the hub passed in
// its environment, so a game never has to trust anything the browser says
// about its own identity or role.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Role = "host" | "player";

export interface TicketClaims {
  v: 1;
  /** Launch id: ties the ticket to one spawned game process. */
  lid: string;
  /** Session room code. */
  code: string;
  /** Game id. */
  gid: string;
  /** Player id, stable across games and refreshes. */
  pid: string;
  name: string;
  role: Role;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signTicket(secret: string, claims: TicketClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

/**
 * Returns the claims when the ticket is authentic, unexpired and issued for
 * this launch and code; otherwise null.
 */
export function verifyTicket(
  secret: string,
  ticket: unknown,
  expect: { lid: string; code: string },
  now: number = Date.now(),
): TicketClaims | null {
  if (typeof ticket !== "string" || ticket.length > 2048) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot !== ticket.lastIndexOf(".")) return null;
  const payload = ticket.slice(0, dot);
  const given = Buffer.from(ticket.slice(dot + 1), "base64url");
  const wanted = mac(secret, payload);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  let claims: TicketClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || claims.v !== 1) return null;
  if (claims.lid !== expect.lid || claims.code !== expect.code) return null;
  if (claims.role !== "host" && claims.role !== "player") return null;
  if (typeof claims.pid !== "string" || typeof claims.name !== "string") return null;
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  return claims;
}
