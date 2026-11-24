// A session is one party: a room code, the people who joined with it, and at
// most one running game. The code outlives any single game, so players join
// once and follow the host from game to game.
//
// This module holds the rules (who can join, when a game is stopped) and is
// transport-agnostic: connections are anything with send() and close().
import { randomInt } from "node:crypto";
import { signTicket, type Role } from "@arcade/sdk/ticket";
import type { GameManifest } from "./catalog.ts";
import { CapacityError, type Launch, type Runner } from "./runner.ts";

export interface Conn {
  send(message: object): void;
  close(): void;
}

export interface Member {
  readonly id: string;
  name: string;
  conns: Set<Conn>;
  lastSeenAt: number;
}

interface ActiveGame {
  manifest: GameManifest;
  status: "starting" | "running";
  launch?: Launch;
  startedAt: number;
  /** Per player id; minted once so a state push never changes the game URL. */
  tickets: Map<string, string>;
}

export interface Session {
  readonly code: string;
  members: Map<string, Member>;
  hostConns: Set<Conn>;
  game: ActiveGame | null;
  /** Last time anyone at all was connected. */
  lastSeenAt: number;
  /** Last time at least one player was connected. */
  lastPlayerAt: number;
}

export type LobbyErrorCode =
  | "bad_code"
  | "full"
  | "busy"
  | "unknown_game"
  | "game_failed"
  | "game_crashed"
  | "too_many_sessions";

export class LobbyError extends Error {
  code: LobbyErrorCode;
  constructor(code: LobbyErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface SessionsOptions {
  runner: Runner;
  /** Called on each use, so a game added to the folder shows up without a restart. */
  games: () => GameManifest[];
  maxPlayers: number;
  maxSessions: number;
  idleMs: number;
  maxGameMs: number;
  now?: () => number;
  log?: (line: string) => void;
}

// No vowels, so codes never spell words; no I/O/Y to misread on a projector.
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const CODE_LENGTH = 4;
export const CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

const HOST_ID = "host";
export const NAME_MAX = 16;

/** Trims a display name to something safe to put on a projector. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

export class Sessions {
  #options: SessionsOptions;
  #now: () => number;
  #log: (line: string) => void;
  #sessions = new Map<string, Session>();
  /** Sessions with a launch or close in flight. */
  #busy = new Set<Session>();

  constructor(options: SessionsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.log(line));
    options.runner.on("exit", (launch: Launch, info: { expected: boolean }) => {
      if (!info.expected) this.#onCrash(launch);
    });
  }

  get(code: unknown): Session | undefined {
    return typeof code === "string" ? this.#sessions.get(code.toUpperCase()) : undefined;
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  create(): Session {
    if (this.#sessions.size >= this.#options.maxSessions) throw new LobbyError("too_many_sessions");
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    } while (this.#sessions.has(code));
    const now = this.#now();
    const session: Session = {
      code,
      members: new Map(),
      hostConns: new Set(),
      game: null,
      lastSeenAt: now,
      lastPlayerAt: now,
    };
    this.#sessions.set(code, session);
    this.#log(`[session ${code}] created`);
    return session;
  }

  attachHost(session: Session, conn: Conn): void {
    session.hostConns.add(conn);
    session.lastSeenAt = this.#now();
    this.broadcast(session);
  }

  /**
   * Seats a player. A known player id takes its seat back (and may update its
   * name); an unknown one gets a new seat if there is room.
   */
  joinPlayer(session: Session, playerId: string, rawName: unknown, conn: Conn): Member {
    let member = session.members.get(playerId);
    const wanted = cleanName(rawName);
    if (!member) {
      if (session.members.size >= this.#options.maxPlayers) throw new LobbyError("full");
      member = { id: playerId, name: "", conns: new Set(), lastSeenAt: this.#now() };
      member.name = this.#uniqueName(session, wanted || `Player ${session.members.size + 1}`, member);
      session.members.set(playerId, member);
    } else if (wanted && wanted !== member.name) {
      this.#rename(session, member, wanted);
    }
    member.conns.add(conn);
    const now = this.#now();
    member.lastSeenAt = session.lastSeenAt = session.lastPlayerAt = now;
    this.broadcast(session);
    return member;
  }

  rename(session: Session, member: Member, rawName: unknown): void {
    const wanted = cleanName(rawName);
    if (!wanted || wanted === member.name) return;
    this.#rename(session, member, wanted);
    this.broadcast(session);
  }

  detach(session: Session, conn: Conn): void {
    let changed = session.hostConns.delete(conn);
    for (const member of session.members.values()) {
      if (member.conns.delete(conn)) {
        member.lastSeenAt = this.#now();
        changed = true;
      }
    }
    if (changed && this.#sessions.get(session.code) === session) this.broadcast(session);
  }

  /** Starts a game for the session, stopping whatever was running first. */
  async launch(session: Session, gameId: unknown): Promise<void> {
    const manifest = this.#options.games().find((game) => game.id === gameId);
    if (!manifest) throw new LobbyError("unknown_game");
    if (this.#busy.has(session)) throw new LobbyError("busy");
    this.#busy.add(session);
    try {
      await this.#stopGame(session);
      const active: ActiveGame = {
        manifest,
        status: "starting",
        startedAt: this.#now(),
        tickets: new Map(),
      };
      session.game = active;
      // Launching counts as activity: a host setting up alone gets the full
      // idle allowance before the game is stopped for having no players.
      session.lastPlayerAt = this.#now();
      this.broadcast(session);

      let launch: Launch;
      try {
        launch = await this.#options.runner.launch(manifest, {
          code: session.code,
          maxPlayers: this.#options.maxPlayers,
        });
      } catch (error) {
        if (session.game === active) session.game = null;
        this.broadcast(session);
        this.#log(`[session ${session.code}] ${manifest.id} failed to start: ${(error as Error).message}`);
        throw new LobbyError(error instanceof CapacityError ? "busy" : "game_failed");
      }

      if (session.game !== active || this.#sessions.get(session.code) !== session) {
        // Closed (or the session ended) while the game was still starting.
        await this.#options.runner.stop(launch.id);
        return;
      }
      active.launch = launch;
      active.status = "running";
      active.startedAt = this.#now();
      this.#log(`[session ${session.code}] ${manifest.id} running`);
      this.broadcast(session);
    } finally {
      this.#busy.delete(session);
    }
  }

  /** Stops the session's game, if any, and returns everyone to the lobby. */
  async closeGame(session: Session, reason: string): Promise<void> {
    if (!session.game) return;
    this.#log(`[session ${session.code}] closing ${session.game.manifest.id}: ${reason}`);
    await this.#stopGame(session);
    this.broadcast(session);
  }

  /** Ends the party: stops the game, tells everyone, forgets the code. */
  async end(session: Session, reason: string): Promise<void> {
    if (this.#sessions.get(session.code) !== session) return;
    this.#sessions.delete(session.code);
    this.#log(`[session ${session.code}] ended: ${reason}`);
    const conns = [...session.hostConns, ...[...session.members.values()].flatMap((m) => [...m.conns])];
    for (const conn of conns) {
      conn.send({ type: "bye", reason });
      conn.close();
    }
    await this.#stopGame(session);
  }

  async endAll(reason: string): Promise<void> {
    await Promise.all(this.list().map((session) => this.end(session, reason)));
  }

  /**
   * The idle policy. Run on a timer; takes the time as an argument so tests
   * can drive it.
   */
  async sweep(now: number = this.#now()): Promise<void> {
    for (const session of this.list()) {
      const playersOn = [...session.members.values()].some((member) => member.conns.size > 0);
      if (playersOn) session.lastPlayerAt = now;
      if (playersOn || session.hostConns.size > 0) session.lastSeenAt = now;

      if (now - session.lastSeenAt > this.#options.idleMs) {
        await this.end(session, "idle");
        continue;
      }

      const game = session.game;
      if (game && game.status === "running" && !this.#busy.has(session)) {
        if (now - game.startedAt > this.#options.maxGameMs) {
          await this.closeGame(session, "max_lifetime");
          this.#notify(session, { type: "notice", code: "max_lifetime" });
        } else if (now - session.lastPlayerAt > this.#options.idleMs) {
          await this.closeGame(session, "idle");
          this.#notify(session, { type: "notice", code: "idle" });
        }
      }

      // Forget players who left long ago, but never mid-game: their seat (and
      // score) should still be there if they come back.
      if (!session.game) {
        let pruned = false;
        for (const member of session.members.values()) {
          if (member.conns.size === 0 && now - member.lastSeenAt > this.#options.idleMs) {
            session.members.delete(member.id);
            pruned = true;
          }
        }
        if (pruned) this.broadcast(session);
      }
    }
  }

  /** What one recipient should render. Sent whole on every change. */
  snapshot(session: Session, to: { role: "host" } | { role: "player"; member: Member }): object {
    const game = session.game;
    let gameView: object | null = null;
    if (game) {
      gameView = { gameId: game.manifest.id, name: game.manifest.name, status: game.status };
      if (game.status === "running" && game.launch) {
        const id = to.role === "host" ? HOST_ID : to.member.id;
        const name = to.role === "host" ? "Host" : to.member.name;
        const page = to.role === "host" ? game.manifest.hostPath : game.manifest.playPath;
        gameView = {
          ...gameView,
          launchId: game.launch.id,
          url: `/g/${game.launch.id}/${page}#t=${this.#ticket(session, game, id, name, to.role)}`,
        };
      }
    }
    return {
      type: "state",
      code: session.code,
      players: [...session.members.values()].map((member) => ({
        id: member.id,
        name: member.name,
        connected: member.conns.size > 0,
      })),
      hostConnected: session.hostConns.size > 0,
      you: to.role === "player" ? { id: to.member.id, name: to.member.name } : null,
      game: gameView,
    };
  }

  broadcast(session: Session): void {
    for (const conn of session.hostConns) conn.send(this.snapshot(session, { role: "host" }));
    for (const member of session.members.values()) {
      if (member.conns.size === 0) continue;
      const state = this.snapshot(session, { role: "player", member });
      for (const conn of member.conns) conn.send(state);
    }
  }

  #notify(session: Session, message: object): void {
    for (const conn of session.hostConns) conn.send(message);
    for (const member of session.members.values()) for (const conn of member.conns) conn.send(message);
  }

  async #stopGame(session: Session): Promise<void> {
    const game = session.game;
    if (!game) return;
    session.game = null;
    if (game.launch) await this.#options.runner.stop(game.launch.id);
  }

  #onCrash(launch: Launch): void {
    for (const session of this.#sessions.values()) {
      if (session.game?.launch?.id !== launch.id) continue;
      this.#log(`[session ${session.code}] ${launch.gameId} crashed`);
      session.game = null;
      this.#notify(session, { type: "error", code: "game_crashed" });
      this.broadcast(session);
    }
  }

  #ticket(session: Session, game: ActiveGame, playerId: string, name: string, role: Role): string {
    let ticket = game.tickets.get(playerId);
    if (!ticket) {
      ticket = signTicket(game.launch!.secret, {
        v: 1,
        lid: game.launch!.id,
        code: session.code,
        gid: game.manifest.id,
        pid: playerId,
        name,
        role,
        // Outlives the game's own maximum lifetime, so it never expires mid-game.
        exp: this.#now() + this.#options.maxGameMs + 3_600_000,
      });
      game.tickets.set(playerId, ticket);
    }
    return ticket;
  }

  #rename(session: Session, member: Member, wanted: string): void {
    member.name = this.#uniqueName(session, wanted, member);
    session.game?.tickets.delete(member.id);
  }

  /** Two players called "Sam" become "Sam" and "Sam 2", so scoreboards stay readable. */
  #uniqueName(session: Session, wanted: string, self: Member): string {
    const taken = new Set(
      [...session.members.values()].filter((m) => m !== self).map((m) => m.name.toLowerCase()),
    );
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = wanted.slice(0, NAME_MAX - suffix.length).trim() + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }
}
