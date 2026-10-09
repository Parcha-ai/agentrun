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
  /** Latest evaluation score (higher is better, in ShowState.scoreUnit); null before the first checkpoint. */
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

/** `agent` is the agent's own words: the notice of a move it was told, or an answer it gave. */
export type NoteKind = "story" | "switch" | "kill" | "takeover" | "winner" | "home" | "agent";
/**
 * A narration line. `measured: true` means every number in `text` was measured by the driver on this run; a feed that
 * does not say, or says false, has its numbers shown as scripted or unmeasured, never as measurements.
 */
export type Note = {
  at: number;
  kind: NoteKind;
  text: string;
  measured?: boolean;
  /**
   * Where a number that was NOT timed here comes from: `simulated` is the simulation's own arithmetic (deterministic for the
   * policy, not wall time); `reported` is what a file says about itself (its host, its training seconds), not something this
   * stage or the tab observed. A note carries at most one basis, and never together with `measured`.
   */
  basis?: "simulated" | "reported";
  /** `tab`: made by the page from what the tab app reported, so real even when the feed is the scripted one. */
  origin?: "tab";
  /**
   * What backs a claim that nothing was lost. Only an independent read-back may back one: `independent-readback` (work/ read back
   * from the object store after the release, its digest equal to what the leaving host acknowledged and to what the pipe sealed) or
   * `chaos-harness` (D0's kill rounds, checked by digest outside the pipe). `pipe-released` is the pipe's own digest of what it wrote
   * under the claim: it is not a read-back of the disk and can never back a zero-loss claim, so it is a value only to be refused.
   */
  evidence?: "independent-readback" | "chaos-harness" | "pipe-released";
  /** How much a viewer needs this line (default 0). When several captions wait, the v2 desk shows the highest rank first, then the oldest. */
  rank?: number;
  /** Captions of one group replace each other: a newer one is shown at once and older ones still waiting are dropped (the version captions: latest wins). */
  group?: string;
  /** Takes the caption slot at once, inside the hold of the one on screen (a moment that explains what the viewer is looking at right now: it is down). */
  urgent?: boolean;
};

/** One turn of the chat with the agent, as the v2 stage shows it: the user's words and the agent's own text. Tool calls and system notices are not turns. */
export type ChatTurn = { id: string; role: "user" | "agent"; text: string; streaming?: boolean };

import type { DecisionData } from "./decision.ts";

/** The latest move decision, with the feed time it arrived. The v2 stage shows it as a card for a few seconds, then the badge moves. */
export type ShownDecision = DecisionData & { at: number };

export type ShowState = {
  /** Where the story comes from: a live driver, or the scripted rehearsal feed. A scripted feed never claims a measurement. */
  source: "live" | "scripted";
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
  /** The conversation with the agent, oldest first. Each chat event replaces it whole, so a replayed event cannot double a turn. */
  chat: ChatTurn[];
  /** The most recent decision about where the run goes, or null before any. */
  decision: ShownDecision | null;
  /** The agent's setup on a machine, before learning starts: when its first command ran (stage clock) and, once it is known, when learning began. */
  setup: { startedAt: number; endedAt: number | null } | null;
  /** Each version's distance in the fixed 10 s window, in order, for the chart: what the feed knows (the tab's own report is added by the page). */
  versions: { n: number; metres: number }[];
  /** What a score means, shown once above the grid ("m walked in 10 s"); empty when the feed does not say. */
  scoreUnit: string;
  /** The environments the switcher offers, in order. */
  environments: { id: string; label: string; kind: HostKind }[];
  /** Which environment the run is in now; null while moving. */
  currentEnv: string | null;
};

/** Everything that can change a ShowState. `at` is ms since origin. */
export type ShowEvent =
  | { t: "run"; at: number; run: string; origin: number; environments: ShowState["environments"]; scoreUnit?: string; source?: ShowState["source"] }
  | { t: "place"; at: number; place: Place; env: string | null }
  | { t: "stay.begin"; at: number; stay: Omit<Stay, "to" | "endedBy"> }
  | { t: "stay.end"; at: number; id: string; endedBy: NonNullable<Stay["endedBy"]> }
  | { t: "universe"; at: number; id: string; patch: Partial<Omit<Universe, "id" | "samples" | "lastEventAt">> & { id?: never } }
  | { t: "sample"; at: number; id: string; score: number; progress?: number; cost?: number }
  | { t: "cost"; at: number; cost: Cost }
  | { t: "note"; at: number; kind: NoteKind; text: string; measured?: boolean; evidence?: Note["evidence"]; rank?: number; group?: string; urgent?: boolean }
  | { t: "chat"; at: number; turns: ChatTurn[] }
  | { t: "decision"; at: number; decision: DecisionData }
  | { t: "setup"; at: number; phase: "start" | "end" }
  /** A version of the brain and how far it walked in the one fixed 10 s window (the chart's point). A feed with no tab to report it (the rehearsal) sends it itself. */
  | { t: "version"; at: number; n: number; metres: number };

/** What the page sends: a command, answered by an event stream, never by a return value. */
export type ShowCommand =
  | { t: "kill"; universe: string }
  | { t: "switch"; to: string }
  | { t: "reset" }
  /** Operator commands: the page never sends them. `fanout` starts the fork fan-out; `collapse` keeps one universe and seals the rest. */
  | { t: "fanout" }
  /** Optional, before fanout: make every machine first, so the fan-out only waits on the forks. */
  | { t: "prewarm" }
  | { t: "collapse"; winner?: string }
  /** Ask the agent a question where it runs now (default: which machine are you on). Feeds with no agent refuse it. */
  | { t: "ask"; text?: string };

/** Messages between the shell and the embedded tab app (same-origin iframe), agreed with D3. Both sides check the origin. */
export type Envelope<T> = { ns: "walks-home" } & T;
export type TabKind = "tab" | "daytona" | "gpu" | "vm";
export type ShellToTab = Envelope<
  | { type: "set-placement"; kind: TabKind; label: string; since: number }
  /** dir is in the creature's heading frame: [1,0] pushes forward, [0,1] pushes left. */
  | { type: "kick"; dir: [number, number]; force_n: number }
  | { type: "open-memory" }
  /** The clean tab (/tab/?clean=1) has two phases: `draw` (the sketcher beside the creature) and `watch` (the creature fills the pane). It also moves to `watch` by itself when the first checkpoint installs. */
  | { type: "set-phase"; phase: "draw" | "watch" }
  | { type: "load-policy"; url: string }
  | { type: "load-design"; design: unknown }
  /** Swap the terrain: a heightfield asset and geoms, or null for the flat floor. */
  | { type: "load-world"; world: { asset: unknown; geoms: unknown } | null }
  /** Answers to the tab's storage requests: the agent's disk, as the stage models it. */
  | { type: "storage-result"; id: number; bytes: Uint8Array | null; etag?: string; notModified?: boolean; error?: string }
  | { type: "storage-written"; id: number; error?: string }
>;
export type TabToShell = Envelope<
  | { type: "ready"; version: string; mujoco?: string; mjcf_sha256?: string }
  | { type: "design-saved"; id: string; name: string; sha256: string }
  | { type: "policy-loaded"; name: string; mjcf_sha256: string; bytes: number }
  /** A policy that could not be fetched or did not match the creature: the tab keeps its previous policy and says why. */
  | { type: "policy-refused"; name: string; reason: string; via?: "watch" | "message" }
  /** A trained policy was installed in the running creature (from the file watcher or a load-policy message). */
  | {
      type: "policy-arrived";
      name: string;
      via: "watch" | "message";
      /** The tab's own toast text, ready to use as a caption. */
      message: string;
      /** What the policy file says about itself (provenance), null when it does not say. */
      host: string | null;
      training_seconds: number | null;
      mjcf_sha256: string;
      /** The preset body the tab switched to so the policy fits, if it did. */
      switched_body: string | null;
      /** MEASURED on the tab's clock. */
      arrival_to_installed_ms: number;
      bytes: number;
      /** A checkpoint from the live training path, or the final home policy. Every install fires this event. REPORTED fields below: what the file says about itself. */
      kind?: "checkpoint" | "final";
      /** 1, 2, 3 ... distinct installs in this page (for a final file, the next number). */
      checkpoint_n?: number;
      steps?: number | null;
      wall_s?: number | null;
      reported_walk_10s_m?: number | null;
    }
  /** A checkpoint from the live path was installed; carries the same fields as policy-arrived. */
  | { type: "checkpoint-installed"; name: string; kind: "checkpoint" | "final"; checkpoint_n: number; steps: number | null; wall_s: number | null; reported_walk_10s_m: number | null }
  /** No trained policy is installed: the creature stands and goes limp. */
  | { type: "untrained"; reason: string }
  /** The creature was lying down when a checkpoint landed and was set back on its feet. */
  | { type: "stood-up"; reason: "checkpoint" }
  /** The browser's own online/offline event, as the tab saw it. */
  | { type: "network"; online: boolean }
  /** Sent once, 10 simulated seconds after the install. */
  | {
      type: "policy-walked";
      name: string;
      /** MEASURED on the tab's clock; null: it never covered half the commanded distance in a second, fell, or command 0. */
      arrival_to_installed_ms: number;
      arrival_to_walking_ms: number | null;
      /** The simulation's own arithmetic, not wall time. */
      sim_seconds_to_walking: number | null;
      mean_speed: number | null;
      /** The simulated seconds this install really ran: 10, or fewer when `partial` (the next checkpoint landed first). */
      window_seconds: number;
      fell: boolean;
      partial?: boolean;
      /** Why the walk has the numbers it has. `cut-short` is not a failure: the next install ended the measurement before it walked, so its time is not measured. */
      outcome?: "walked" | "fell" | "not-walking" | "cut-short";
      /** The install this result is about (the tab's own count), so a result that lands after the next checkpoint is not credited to it. */
      checkpoint_n?: number;
    }
  /** The first stroke on the sketcher (or a design applied from outside): the stage can drop its "draw a creature" prompt. Once per page. */
  | { type: "draw-started" }
  /** About once per simulated second while a policy runs: how far the creature has walked since the current version started. */
  | {
      type: "walk-meter";
      /** Simulated seconds on the tab's own clock, the same clock as policy-walked's windows. */
      t: number;
      /** Straight-line metres on the ground from where the current version started (where it stood when its policy was installed, or when it was reset or rebuilt); starts over for every version. The same number as the tab's on-screen distance. */
      metres: number;
      /** The checkpoint number of the version running (0: none). */
      version: number;
      state: "untrained" | "learning" | "trained" | "dummy";
    }
  /** The disk answered storage-written with error "not-holder" (another machine holds the run): the design is kept locally and handed to the agent. */
  | { type: "design-request"; design: unknown; mjcf_sha256: string }
  | { type: "kicked"; force_n: number; t: number }
  | { type: "memory-opened"; rows: number }
  | { type: "fell"; t: number }
  | { type: "stood"; t: number; since_kick?: number }
  /**
   * Only for a policy that carries a getup network: "getup" = the creature went down and the getup network took over (torso
   * uprightness fell below 0.3), "walk" = it is back on its feet (above 0.9). `t` is simulated seconds, `up` is 1 upright, 0 on
   * its side, -1 on its back. The tab's own simulation arithmetic, not wall time.
   */
  | { type: "mode-changed"; mode: "walk" | "getup"; t: number; up: number }
  /** The tab keeps creature/designs.sqlite and creature/memory.sqlite on the agent's disk; with no answer in 1.5 s it falls back to the browser. */
  | { type: "storage-read"; id: number; path: string; ifNoneMatch?: string }
  | { type: "storage-write"; id: number; path: string; bytes: Uint8Array }
>;

export const GRID = { rows: 2, cols: 4, slots: 8 } as const;
