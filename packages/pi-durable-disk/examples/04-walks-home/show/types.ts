// The contract between the stage (this package) and whatever produces the run's story (D1's universes driver, or the
// scripted fake feed in scenario.ts). The stage only reads a ShowState and the ShowEvents that change it; it never
// talks to a cloud. Invariants:
//   - A ShowState is fully determined by folding ShowEvents (reduce.ts) over `emptyState()`; `GET /state` returns the
//     fold so far, `GET /events` streams the events after it, so a late page and a live page agree.
//   - Times are milliseconds since the run's origin (`ShowState.origin` is the wall-clock ms of 0), never wall-clock.
//   - `host` is the driver's own label for the machine, the same string the agent's env.switch notice uses.

/** Where the run is, in the words of 03-tab-to-cloud's Placement, reduced to what the stage draws. */
export type Place =
  | { where: "tab"; host: string }
  | { where: "cloud"; host: string }
  | { where: "universes"; host: string }
  | { where: "moving"; to: string; host: string }
  | { where: "home"; host: string }
  | { where: "parked" };

/** What kind of machine a host is; the stage colors by it. */
export type HostKind = "tab" | "sandbox" | "vm" | "gpu" | "pipe";

/**
 * One universe's life. Small on purpose:
 *   spare     idle machine held ready (slot null)
 *   starting  claimed a slot, not yet training
 *   training  producing checkpoints
 *   killed    its machine is gone (slot kept until a spare takes over or the stage is told to drop it)
 *   takeover  a spare is resuming the killed universe's run (the ~2 s on camera)
 *   winner    chosen to continue
 *   sealed    finished or not chosen; read-only
 */
export type UniverseStatus = "spare" | "starting" | "training" | "killed" | "takeover" | "winner" | "sealed";

export type Universe = {
  id: string;
  /** Grid cell 0..7 (row-major, 2 rows by 4), or null for a spare and for a fallen universe past its takeover. */
  slot: number | null;
  status: UniverseStatus;
  host: string;
  hostKind: HostKind;
  /** The reward variant this universe trains against, one short line ("forward speed + upright bonus"). */
  reward: string;
  /** 0..1 progress of the universe's time budget. */
  progress: number;
  /** Latest evaluation score (higher is better); null before the first checkpoint. */
  score: number | null;
  /** Score history, oldest first, one point per checkpoint. */
  samples: { at: number; score: number }[];
  /** Spend so far in USD. */
  cost: number;
  /** When it left `starting`/`spare`; used for age. */
  startedAt: number | null;
  /** Set on a spare that took over: the killed universe it replaced; and on the killed one: its replacement. */
  replaces?: string;
  replacedBy?: string;
  /** Last time anything about this universe changed, for "quiet for N s" hints. */
  lastEventAt: number;
};

/** A stretch of time the run, or one universe, lived on a machine. `to: null` means still there. */
export type Stay = {
  id: string;
  /** "run" for the main line, "u:<universe id>" for a universe's own line. */
  lane: string;
  host: string;
  hostKind: HostKind;
  from: number;
  to: number | null;
  /** How the stay began: the handover that put the run here. */
  handover?: { fromHost: string; ms: number; planned: boolean };
  /** Why it ended, when it ended without a planned move. */
  endedBy?: "switch" | "killed" | "sealed";
};

export type Cost = {
  usd: number;
  ratePerMin: number;
  /** Optional cap shown as a bar; no cap is a number the driver sets, never one the stage invents. */
  cap?: number;
};

export type NoteKind = "story" | "switch" | "kill" | "takeover" | "winner" | "home";
export type Note = { at: number; kind: NoteKind; text: string };

export type ShowState = {
  /** Wall-clock ms (Date.now()) of time 0. */
  origin: number;
  /** Latest time any event carried. */
  now: number;
  run: string;
  place: Place;
  universes: Record<string, Universe>;
  stays: Stay[];
  cost: Cost;
  /** Narration lines, newest last; the stage shows the tail. */
  notes: Note[];
  /** The environments the switcher offers, in order. */
  environments: { id: string; label: string; kind: HostKind }[];
  /** Which environment the run is in now; null while moving. */
  currentEnv: string | null;
};

/** Everything that can change a ShowState. `at` is ms since origin. */
export type ShowEvent =
  | { t: "run"; at: number; run: string; origin: number; environments: ShowState["environments"] }
  | { t: "place"; at: number; place: Place; env: string | null }
  | { t: "stay.begin"; at: number; stay: Omit<Stay, "to" | "endedBy"> }
  | { t: "stay.end"; at: number; id: string; endedBy: NonNullable<Stay["endedBy"]> }
  | { t: "universe"; at: number; id: string; patch: Partial<Omit<Universe, "id" | "samples" | "lastEventAt">> & { id?: never } }
  | { t: "sample"; at: number; id: string; score: number; progress?: number; cost?: number }
  | { t: "cost"; at: number; cost: Cost }
  | { t: "note"; at: number; kind: NoteKind; text: string };

/** What the page sends: a command, answered by an event stream, never by a return value. */
export type ShowCommand =
  | { t: "kill"; universe: string }
  | { t: "switch"; to: string }
  | { t: "reset" }
  /** Operator commands: the page never sends them. `fanout` starts the fork fan-out; `collapse` keeps one universe and seals the rest. */
  | { t: "fanout" }
  | { t: "collapse"; winner?: string };

/** Messages between the shell and the embedded tab app (same-origin iframe), agreed with D3. Both sides check the origin. */
export type Envelope<T> = { ns: "walks-home" } & T;
export type TabKind = "tab" | "daytona" | "gpu" | "vm";
export type ShellToTab = Envelope<
  | { type: "set-placement"; kind: TabKind; label: string; since: number }
  /** dir is in the creature's heading frame: [1,0] pushes forward, [0,1] pushes left. */
  | { type: "kick"; dir: [number, number]; force_n: number }
  | { type: "open-memory" }
  | { type: "load-policy"; url: string }
  | { type: "load-design"; design: unknown }
  /** Answers to the tab's storage requests: the agent's disk, as the stage models it. */
  | { type: "storage-result"; id: number; bytes: Uint8Array | null; error?: string }
  | { type: "storage-written"; id: number; error?: string }
>;
export type TabToShell = Envelope<
  | { type: "ready"; version: string; mujoco?: string; mjcf_sha256?: string }
  | { type: "design-saved"; id: string; name: string; sha256: string }
  | { type: "policy-loaded"; name: string; mjcf_sha256: string; bytes: number }
  | { type: "kicked"; force_n: number; t: number }
  | { type: "memory-opened"; rows: number }
  | { type: "fell"; t: number }
  | { type: "stood"; t: number; since_kick?: number }
  /** The tab keeps creature/designs.sqlite and creature/memory.sqlite on the agent's disk; with no answer in 1.5 s it falls back to the browser. */
  | { type: "storage-read"; id: number; path: string }
  | { type: "storage-write"; id: number; path: string; bytes: Uint8Array }
>;

export const GRID = { rows: 2, cols: 4, slots: 8 } as const;
