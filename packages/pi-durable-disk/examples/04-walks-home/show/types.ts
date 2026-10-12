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
  /** A moment that is only true for a short while (a progress mark beside a counter that moves on): older than this when its turn comes, it is skipped, not shown late. */
  maxLagMs?: number;
  /** A moment the viewer is promised: the desk never drops it to catch up with a burst (it waits its turn), and it stays news for KEPT_NEWS_MS instead of the usual 15 s. */
  keep?: boolean;
  /** How long this caption may stay up, at most (never less than the desk's minimum hold): a moment such as "three quarters of the way through" is not true for long, and must not outlive the step it describes. */
  showMs?: number;
};

/** One turn of the chat with the agent, as the v2 stage shows it: the user's words and the agent's own text. Tool calls and system notices are not turns. */
/** `unanswered`: the turn is not an answer the model gave and that passed (an error, a refusal, a turn given up on), so nothing about "the answer" belongs beside it. */
export type ChatTurn = { id: string; role: "user" | "agent"; text: string; streaming?: boolean; unanswered?: boolean;
  /** What the model thought out loud before answering (the obsession episode): the tab sends it cumulatively, and it has passed the same safety check as the answer. */
  thinking?: string;
  /** The tab says the answer hit its token budget and was cut back to the last sentence or line end: shown as a visible mark, never a silent trim. */
  cut?: boolean;
  /** After the brain swap: this turn is in the conversation whose brain is the model this run trained (not the cloud agent's, before the swap). */
  brain?: boolean;
};

/**
 * The brain swap, from the transcript's `brain` entries (chat-items.ts): after home the trained model becomes the agent's brain inside the 03 page. `loading`: it is coming home;
 * `ready`: the swap, the payoff; `failed`: no swap, the agent keeps its brain. Every field is what the entry said; a field it did not say is null.
 */
export type Brain = {
  stage: "loading" | "ready" | "failed";
  id: string;
  text: string;
  name: string | null;
  bytes: number | null;
  quant: string | null;
  sha256: string | null;
  topic: string | null;
  mechanism: string | null;
  provider: string | null;
  model: string | null;
  conversation: number | null;
  loadMs: number | null;
  firstAnswerMs: number | null;
  tokensPerS: number | null;
  reason: string | null;
};

/**
 * The tab's own events for the robot demo beats (D3's `walkshome:*` events, as DOM events in the page and as messages to the stage; the 03 page's transcript says the same things as `brain`
 * entries). Every field is what the event said; a field it did not say is null.
 */
export type Net = { online: boolean; reason: string | null };
export type Checkin = { phase: "start" | "done" | "failed"; head: string | null; files: number | null; changes: number | null; ms: number | null; message: string | null; code: string | null; resumed: boolean };
/** One routing decision: who answers the next message and why (`brain.decision`). `confidence` is Jev's probability of the brain it chose, null when a rule decided. */
export type Routing = { brain: "tab-local" | "cloud"; answering: string | null; reason: string; confidence: number | null; decidedBy: "jev" | "rule" | null; ms: number | null; probabilities: { local: number; cloud: number } | null };
/** What a homecoming downloaded (the model host's `model-homecoming`): whether the base had to come at all, the adapters, and the bytes and time. */
export type Homecoming = { baseFetched: boolean; adapters: string[]; plannedBytes: number | null; fetchedBytes: number | null; fetchMs: number | null; loadMs: number | null; name: string | null; prefetch: boolean };
/**
 * One thread of the agent: a child conversation of the one session, with its compute on its own GPU, teaching the robot one skill. The checkpoints are the skill's own measure, in its own unit.
 * A field an event did not carry is null; the stage claims nothing for it.
 */
export type Thread = {
  id: string;
  skill: string | null;
  /** The GPU box's own label ("H100 #3"). */
  host: string | null;
  status: "starting" | "learning" | "done" | "failed";
  /** How long the box took to come up, measured by the pool. */
  acquireMs: number | null;
  costUsd: number | null;
  /** What the skill is measured by, in its own words and unit ("spin rate", "rad/s"), and what passing means (">= 1.0"). */
  metric: string | null;
  unit: string | null;
  target: string | null;
  /** The body this skill was trained for (its model file's sha256) and the body's name, from the skill's own file. */
  mjcf: string | null;
  bodyName: string | null;
  /** Seconds from the thread's start to its first passing checkpoint, and to the thread being done (D2's passed_at.t and wall_s). */
  passedS: number | null;
  wallS: number | null;
  /** How long this skill would take to first pass on a CPU machine (D2's estimate from this run's steps and a measured throughput), and which machine. */
  cpuS: number | null;
  cpuCores: string | null;
  /** The skill is installed in the one robot. */
  home: boolean;
  points: { n: number; value: number | null; at: number; passes: boolean | null; fell: boolean; seconds: number | null }[];
  /** When the thread was last heard from. */
  at: number;
};

/** The round the cluster just finished (work/skills/round.json, D2's assembler): the body it trained, whether that replaced another body's home, the GPUs, and the largest times with the CPU baseline. */
export type Round = {
  bodySha: string;
  bodyName: string | null;
  previousSha: string | null;
  relearn: boolean;
  gpus: number | null;
  allPassedS: number | null;
  allDoneS: number | null;
  cpuS: number | null;
  cpuCores: string | null;
  /** Which of its numbers are estimates, and which were measured, in her words ("cpu_estimate_s" ...). */
  estimated: string[];
  measured: string[];
};

/** The tab's `body-mismatch` event: the body changed and these installed skills were taught for another one (the robot stumbles with them until they are relearned). */
export type Stumble = { previousSha: string | null; bodySha: string; notFitting: string[]; fitting: string[] };

/** One tool call of the current task, as the transcript says it. `args` is the call's JSON as the transcript holds it. */
export type ToolRow = { id: string; name: string; args: string; output: string; status: "running" | "done" | "error" | "interrupted" };

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
  /** The latest brain entry the transcript has said (loading, ready or failed), null before any and on a run that never brings a model home. A second homecoming writes more entries; a later one replaces this. */
  brain: (Brain & { at: number }) | null;
  /** The latest `ready` entry: the model that is the agent's brain now. It stays through a newer loading or failed entry (a replacement that is still coming, or that did not load). */
  brainReady: (Brain & { at: number }) | null;
  /** Online or offline, from the tab's own signal; null until the tab has said. */
  net: (Net & { at: number }) | null;
  /** The latest check-in (a run coming back from offline); null before any. */
  checkin: (Checkin & { at: number }) | null;
  /** The latest routing decision, and every one so far in order (the closing strip folds the handoffs from them). */
  routing: (Routing & { at: number }) | null;
  routings: (Routing & { at: number })[];
  /** The latest homecoming's bytes; null before any. */
  homecoming: (Homecoming & { at: number }) | null;
  /** The tool calls of the current task, in order (the transcript's, replaced whole each time). */
  tools: ToolRow[];
  /** The latest round the cluster finished (round.json); null until it is written. */
  round: (Round & { at: number }) | null;
  /** The latest body change the tab reported, with the skills that no longer fit; null until it says so. */
  stumble: (Stumble & { at: number }) | null;
  /** The body the robot has now (home/skills.json's body_mjcf_sha256, the sha256 of its model file): a skill trained for another body is a relearn. Null until the disk says. */
  robotBody: { sha: string; at: number } | null;
  /** The agent's threads, in the order they first appeared (a tile never moves). Empty until the agent splits. */
  threads: Thread[];
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
  | { t: "note"; at: number; kind: NoteKind; text: string; measured?: boolean; evidence?: Note["evidence"]; rank?: number; group?: string; urgent?: boolean; keep?: boolean; showMs?: number }
  | { t: "chat"; at: number; turns: ChatTurn[] }
  | { t: "brain"; at: number; brain: Brain }
  | { t: "net"; at: number; net: Net }
  | { t: "checkin"; at: number; checkin: Checkin }
  | { t: "routing"; at: number; routing: Routing }
  | { t: "homecoming"; at: number; homecoming: Homecoming }
  /** The model is loaded: how long that took, joined to the fetch it follows. */
  | { t: "homecoming.loaded"; at: number; loadMs: number }
  | { t: "tools"; at: number; tools: ToolRow[] }
  /** A thread's fields change (it is made by its first patch). */
  /** The robot's body, as the run's disk says it (home/skills.json). */
  | { t: "body"; at: number; sha: string }
  | { t: "round"; at: number; round: Round }
  | { t: "stumble"; at: number; stumble: Stumble }
  | { t: "thread"; at: number; id: string; patch: Partial<Omit<Thread, "id" | "points" | "at">> }
  /** A thread's checkpoint: how well it does its skill, `value` in `unit`. The same or an older `n` is a repeat. */
  | { t: "thread.point"; at: number; id: string; n: number; value: number | null; unit?: string; passes?: boolean | null; fell?: boolean; seconds?: number | null }
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
  /**
   * The creature was lying down and was set back on its feet, and why: a policy arrived (a checkpoint or the final one), a skill was chosen (`skill` names it; its policy has no get-up network, so it could not rise
   * under it), or it stayed down for a few seconds under a policy with no get-up network (`fallen`). Only the first two are a new brain.
   */
  | { type: "stood-up"; reason: "checkpoint" | "final" | "skill" | "fallen"; skill?: string }
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
