export interface Player {
  /** Stable for the whole party: survives refreshes and switching games. */
  readonly id: string;
  readonly name: string;
  /** False while the player's phone is asleep or reconnecting. */
  readonly connected: boolean;
}

export interface Game<S> {
  /** Your game's state. Mutate it freely inside handlers and timers. */
  state: S;
  /** The room code shown on the projector. */
  readonly code: string;
  /** Everyone who has joined this game, in join order. Never includes the host. */
  readonly players: readonly Player[];
  readonly hostConnected: boolean;

  /** Run `fn` once after `ms`. Starting a timer with a name in use replaces it. */
  timer(name: string, ms: number, fn: () => void): void;
  clearTimer(name: string): void;
  /** When the named timer fires, as epoch milliseconds; undefined if not running. */
  deadline(name: string): number | undefined;

  /** One-off message to a player or the host, outside the view (e.g. a buzz). */
  send(to: Player | "host", type: string, data?: unknown): void;
  /** One-off message to the host and every player. */
  broadcast(type: string, data?: unknown): void;

  /**
   * Push views now. Only needed after changing state outside a handler or
   * timer (for example in a promise callback); those sync automatically.
   */
  sync(): void;
  /** Ask the hub to close this game and return everyone to the lobby. */
  end(): void;
}

export interface GameDefinition<S> {
  /** Build the starting state. Called once, before anyone connects. */
  init(info: { code: string; maxPlayers: number }): S;

  /** Actions the host screen may send, keyed by the name passed to `game.send`. */
  onHost?: Record<string, (game: Game<S>, data: any) => void>;
  /** Actions a phone may send. */
  onPlayer?: Record<string, (game: Game<S>, player: Player, data: any) => void>;

  /** A player joined for the first time (not called on reconnect). */
  onJoin?(game: Game<S>, player: Player): void;
  /** A player's connection dropped. They may come back. */
  onLeave?(game: Game<S>, player: Player): void;

  /** What the projector shows. Must be JSON-serialisable. */
  hostView(game: Game<S>): unknown;
  /** What one phone shows. Only that player receives it. */
  playerView(game: Game<S>, player: Player): unknown;

  /** Folder with host.html, play.html and assets. Default: `public` beside the server. */
  publicDir?: string;
}
