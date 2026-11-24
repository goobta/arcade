// Starts and stops game processes. Knows nothing about sessions or players:
// it is handed a manifest, and reports when the process is healthy or gone.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { GameManifest } from "./catalog.ts";

export type LaunchStatus = "starting" | "running" | "stopping" | "exited";

export interface Launch {
  /** Random per spawn. It is the proxy path, so a stale tab cannot reach the next game. */
  readonly id: string;
  readonly gameId: string;
  readonly port: number;
  /** Signs this launch's tickets. Dies with the process. */
  readonly secret: string;
  readonly startedAt: number;
  readonly pid: number | undefined;
  status: LaunchStatus;
}

export class CapacityError extends Error {
  constructor() {
    super("no free game slot");
    this.name = "CapacityError";
  }
}

export interface RunnerOptions {
  maxGames: number;
  portBase: number;
  heapMb: number;
  publicUrl: string;
  /** How long a game gets to exit after SIGTERM before it is killed. */
  killAfterMs?: number;
  log?: (line: string) => void;
}

interface Slot {
  launch: Launch;
  child: ChildProcess;
  exited: Promise<void>;
  /** True once we asked it to stop, so its exit is not reported as a crash. */
  stopRequested: boolean;
  /** True once it passed its health check. */
  started: boolean;
}

// Last resort if the hub is going down without a clean stopAll().
const runners = new Set<Runner>();
process.on("exit", () => {
  for (const runner of runners) runner.killAllNow();
});

/**
 * Events:
 *   "exit" (launch, { expected: boolean }) - the process is gone and its slot is free.
 */
export class Runner extends EventEmitter {
  #options: Required<RunnerOptions>;
  #slots = new Map<number, Slot>();
  #byId = new Map<string, Slot>();

  constructor(options: RunnerOptions) {
    super();
    this.#options = { killAfterMs: 3000, log: (line) => console.log(line), ...options };
    runners.add(this);
  }

  /** Synchronous: for the hub's own exit handler only. */
  killAllNow(): void {
    for (const slot of this.#byId.values()) this.#signal(slot, "SIGKILL");
  }

  get(id: string): Launch | undefined {
    return this.#byId.get(id)?.launch;
  }

  list(): Launch[] {
    return [...this.#byId.values()].map((slot) => slot.launch);
  }

  /** Resolves once the game answers its health check. Rejects if it never does. */
  async launch(
    game: GameManifest,
    info: { code: string; maxPlayers: number },
  ): Promise<Launch> {
    const index = this.#freeSlot();
    if (index === undefined) throw new CapacityError();

    const id = randomBytes(12).toString("base64url");
    const port = this.#options.portBase + index;
    const secret = randomBytes(32).toString("base64url");
    const heap = game.maxHeapMb ?? this.#options.heapMb;

    // Built from scratch rather than copied from the hub: the host PIN and
    // anything else in the hub's environment must not reach game code.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/tmp",
      TZ: process.env.TZ,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      NODE_OPTIONS: `--max-old-space-size=${heap}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      BASE_PATH: `/g/${id}`,
      ARCADE_CODE: info.code,
      ARCADE_GAME_ID: game.id,
      ARCADE_LAUNCH_ID: id,
      ARCADE_SECRET: secret,
      ARCADE_PUBLIC_URL: this.#options.publicUrl,
      ARCADE_MAX_PLAYERS: String(Math.min(info.maxPlayers, game.maxPlayers)),
      ARCADE_PARENT_PID: String(process.pid),
    };

    const [command, ...args] = game.start;
    const child = spawn(command === "node" ? process.execPath : command, args, {
      cwd: game.dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so stopping it also stops anything it spawned.
      detached: true,
    });

    const launch: Launch = {
      id,
      gameId: game.id,
      port,
      secret,
      startedAt: Date.now(),
      pid: child.pid,
      status: "starting",
    };
    const tag = `[${game.id}:${id.slice(0, 6)}]`;
    this.#pipe(child.stdout, tag);
    this.#pipe(child.stderr, tag);

    let spawnError: Error | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
        resolve();
      });
      child.once("exit", () => resolve());
    });
    const slot: Slot = { launch, child, exited, stopRequested: false, started: false };
    this.#slots.set(index, slot);
    this.#byId.set(id, slot);

    void exited.then(() => {
      launch.status = "exited";
      this.#slots.delete(index);
      this.#byId.delete(id);
      this.#options.log(
        `${tag} exited (code ${child.exitCode}, signal ${child.signalCode})` +
          (spawnError ? `: ${spawnError.message}` : ""),
      );
      // Only a game that had started reports here; a failed start is reported
      // by launch() rejecting.
      if (slot.started) this.emit("exit", launch, { expected: slot.stopRequested });
    });

    const healthy = await this.#waitHealthy(slot, game);
    if (!healthy) {
      const reason = spawnError
        ? `could not start: ${spawnError.message}`
        : launch.status === "exited"
          ? "exited before becoming healthy"
          : `not healthy after ${game.startTimeoutMs} ms`;
      await this.#stopSlot(slot);
      throw new Error(`${game.id} ${reason}`);
    }
    if (slot.stopRequested) throw new Error(`${game.id} was stopped while starting`);
    launch.status = "running";
    slot.started = true;
    this.#options.log(`${tag} running on port ${port} after ${Date.now() - launch.startedAt} ms`);
    return launch;
  }

  /** Resolves when the process is gone. Safe to call twice or with an unknown id. */
  async stop(id: string): Promise<void> {
    const slot = this.#byId.get(id);
    if (slot) await this.#stopSlot(slot);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#byId.values()].map((slot) => this.#stopSlot(slot)));
  }

  #freeSlot(): number | undefined {
    for (let index = 0; index < this.#options.maxGames; index++) {
      if (!this.#slots.has(index)) return index;
    }
    return undefined;
  }

  async #waitHealthy(slot: Slot, game: GameManifest): Promise<boolean> {
    const url = `http://127.0.0.1:${slot.launch.port}/${game.healthPath}`;
    const deadline = Date.now() + game.startTimeoutMs;
    while (Date.now() < deadline) {
      if (slot.launch.status === "exited" || slot.stopRequested) return false;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return true;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async #stopSlot(slot: Slot): Promise<void> {
    if (slot.launch.status === "exited") return;
    if (!slot.stopRequested) {
      slot.stopRequested = true;
      slot.launch.status = "stopping";
      this.#signal(slot, "SIGTERM");
      const timer = setTimeout(() => this.#signal(slot, "SIGKILL"), this.#options.killAfterMs);
      void slot.exited.then(() => clearTimeout(timer));
    }
    await slot.exited;
  }

  #signal(slot: Slot, signal: NodeJS.Signals): void {
    const pid = slot.child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal); // the whole process group
    } catch {
      try {
        slot.child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  #pipe(stream: NodeJS.ReadableStream | null, tag: string): void {
    if (!stream) return;
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) this.#options.log(`${tag} ${line}`);
    });
    stream.on("end", () => {
      if (rest) this.#options.log(`${tag} ${rest}`);
    });
  }
}
