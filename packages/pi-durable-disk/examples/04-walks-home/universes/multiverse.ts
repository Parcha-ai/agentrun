// The multiverse: one sealed run forked into N universes, each placed on its own machine by a fleet, watched over the
// disk's S3 API, a killed machine's universe taken over by a warm spare, and the collapse that keeps one universe
// running and seals the rest. Host-agnostic: machines and how a run reaches them (the transport) come from a `Fleet`
// (direct.ts: the machine mounts the run; a pipe: the server holds the claim and the machine runs the agent through it),
// and every change the stage draws is a ShowEvent (show/types.ts), so the panel is the fold of what happened here.
//
// Invariants:
//   - A universe's run has one writer. A takeover goes through the fleet's transport, which keeps it: a direct fleet
//     revokes the dead holder's delegation before the spare mounts (Archil fences a holder that was not quite dead); a
//     pipe refuses every frame of the dead writer's connection once the spare's is attached.
//   - The orchestrator never mounts a universe's run itself, except while forking it; it reads `run.json` and the
//     workload's progress over S3.
//   - A show line is one machine's life in the grid: a spare that takes over a killed universe becomes that universe's
//     line in the same slot (`replaces`), as the stage's contract says.
//   - A note says `measured` only when every number in it was measured on this run.
import type { ArchilHost, CheckControl, ControlApi, ForkOptions, ForkResult, HostStatus, RunRef, SupervisorControl } from "@parcha/pi-durable-disk";
import { fork, readRunStatus, runPath } from "@parcha/pi-durable-disk";
import type { Cost, HostKind, NoteKind, ShowEvent, Universe, UniverseStatus } from "./show/types.ts";

export type Control = SupervisorControl & CheckControl & ControlApi;

/** A machine a universe can run on. */
export interface Machine {
  /** Unique within the fleet (a box name). */
  readonly id: string;
  /** What the agent's env.switch notice calls this machine, and the stage's `host`. */
  readonly label: string;
  readonly kind: HostKind;
  /** List price while it exists, USD per hour. */
  readonly ratePerHour: number;
  /** Wall-clock ms it began to cost. */
  readonly since: number;
}

/** What brought a run to a machine; the instance turns it into its env.switch notice. */
export interface Arrival {
  readonly switchId: string;
  readonly from: string;
  readonly planned: boolean;
}

/** A run on a machine, as a fleet placed it; what the placement holds is the fleet's own business. */
export interface Placed {
  readonly run: RunRef;
  readonly machine: Machine;
}

export type PlaceResult = {
  readonly placed: Placed;
  /** Delegations a direct takeover revoked from the placement it replaces; 0 through a pipe. */
  readonly revoked: number;
  /** Wall ms the machine was handed the run (direct: the driver's start returned; pipe: the box was invited). */
  readonly launchedAt: number;
  /** Wall ms the run was open on the machine (direct: run.json at the new generation; pipe: the writer attached). */
  readonly openedAt: number;
  /** The supervisor's own start time, when the transport has one. */
  readonly startMs?: number;
};

/** How a fleet's runs reach its machines: the machine mounts the run, or the server holds it and pipes it over. */
export type Transport = "direct" | "pipe";

/** Where universes run, and how a run gets there. */
export interface Fleet {
  readonly transport: Transport;
  /** Create a machine and make it ready to take a run: started, set up, no claim and no mount. */
  warm(name: string): Promise<Machine>;
  /**
   * Run `run` on `machine` (warm, holding nothing) with this environment (the universe and its arrival). `from` is the
   * placement this one replaces, whose machine is dead or dying: the transport takes the run from it with one writer
   * kept. Resolves once the run is open on `machine`.
   */
  place(run: RunRef, machine: Machine, env: Readonly<Record<string, string>>, from?: Placed): Promise<PlaceResult>;
  /** The placement's machine as the fleet sees it; `gone`, `stopped` or `failed` is a machine that died. */
  status(placed: Placed): Promise<HostStatus>;
  /** Drain the run, seal its run.json, and delete the machine. */
  seal(placed: Placed): Promise<void>;
  /** Power the machine off now: whatever runs there gets no drain, the way a machine dies. */
  kill(machine: Machine): Promise<void>;
  /** Delete a machine that holds no run (a spare nobody needed). */
  retire(machine: Machine): Promise<void>;
}

export interface UniverseSpec {
  /** The stage's id for the universe's first line ("u1" .. "u8"). */
  readonly id: string;
  /** The reward variant it trains against, one short line. */
  readonly reward: string;
  /** Extra environment for its instance (trainer settings). */
  readonly env?: Readonly<Record<string, string>>;
}

/** What a universe's workload says after each checkpoint (durable on the disk before it says so). */
export interface Progress {
  readonly step: number;
  readonly total: number;
  /** Latest evaluation score, higher is better. */
  readonly score: number;
  /** 0..1 of the universe's budget. */
  readonly progress: number;
  readonly done: boolean;
  /** The incarnation that wrote it. */
  readonly generation: number;
  /** The machine label the writer was told it runs on. */
  readonly host: string;
  readonly at: string;
  /** What the score means, when the workload says ("m along the course in 20 s"). */
  readonly unit?: string;
  /**
   * False while the writer's current segment has no checkpoint yet (a trainer that started, or resumed, and is still
   * compiling): it says where the run is, not that it trains. Absent means it is a checkpoint.
   */
  readonly checkpointed?: boolean;
}

export const PROGRESS_FILE = "work/universe/progress.json";

/** The stand-in trainer's `progress.json` (trainer.ts), read over S3. */
export async function readProgressJson(control: Pick<Control, "getObject">, run: RunRef): Promise<Progress | null> {
  try {
    return JSON.parse(new TextDecoder().decode(await control.getObject(`${runPath(run.id)}/${PROGRESS_FILE}`))) as Progress;
  } catch {
    return null;
  }
}

export interface MultiverseOptions {
  readonly control: Control;
  readonly fleet: Fleet;
  /** The run to fork: released and sealed (paused, sleeping, done or failed). */
  readonly source: RunRef;
  /** Where the source run lived, in the notice's words ("your browser tab"). */
  readonly sourceLabel: string;
  readonly universes: readonly UniverseSpec[];
  /** Warm machines kept ready for takeovers. */
  readonly spares: number;
  /** The forks' own mounts on this host go under `<mountRoot>/.fork-*`. */
  readonly mountRoot: string;
  readonly forkHost?: ArchilHost;
  /** Universe runs are `<runPrefix><universe id>`; the prefix should carry a stamp so reruns never collide. */
  readonly runPrefix: string;
  /** Machines are named `<machinePrefix><line id>`. */
  readonly machinePrefix: string;
  readonly emit: (event: ShowEvent) => void;
  /** Wall-clock ms of the show's time 0. */
  readonly origin: number;
  /** How a universe's checkpoints are read. Default: the stand-in trainer's `work/universe/progress.json`. */
  readonly progress?: (run: RunRef, spec: UniverseSpec) => Promise<Progress | null>;
  /** The workload's score is a measurement (D2's evaluation), not a stand-in: the winner's note says so to the stage. */
  readonly scoresMeasured?: boolean;
  /** How long a takeover waits for the spare's first checkpoint (a trainer compiling first takes minutes). Default 60 s. */
  readonly resumeTimeoutMs?: number;
  /** How often runs are read over S3. Default 1 s. */
  readonly pollMs?: number;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /** Every disk resource this process creates or removes (fork tokens, mounts, run directories). */
  readonly onResource?: (kind: string, id: string, note?: string) => void;
  readonly now?: () => number;
  /** How the source becomes the universes' runs; replaceable so tests can script the disk. Default: `fork`, one by one. */
  readonly forkAll?: (source: RunRef, ids: readonly string[], options: ForkOptions) => Promise<{ run: string; ms: number; files: number; bytes: number }[]>;
}

/** One stage line: a machine's life in the grid, and the run it holds when it holds one. */
interface Line {
  readonly id: string;
  slot: number | null;
  status: UniverseStatus;
  machine: Machine | null;
  /** Resolves when the machine is ready; rejects when it could not be made. */
  ready: Promise<Machine>;
  run: RunRef | null;
  spec: UniverseSpec | null;
  placed: Placed | null;
  stay: string | null;
  /** The last checkpoint step seen, and the generation that wrote it. */
  step: number;
  generation: number;
  score: number | null;
  /** Wall ms the machine stopped costing (killed, retired, sealed). */
  ended: number | null;
  /** Set while this process is killing or replacing its machine, so a poll does not take it over twice. */
  leaving: boolean;
}

export type FanOutReport = {
  readonly forks: { run: string; ms: number; files: number; bytes: number }[];
  readonly forkMs: number;
  readonly starts: { line: string; run: string; host: string; ms: number; startMs: number | null }[];
  readonly ms: number;
};

export type TakeoverReport = {
  readonly killed: string;
  readonly by: string;
  readonly run: string;
  readonly transport: Transport;
  /** Kill call made to the replacement's run open. */
  readonly openMs: number;
  /** ...to the replacement's first checkpoint. */
  readonly trainingMs: number | null;
  readonly killMs: number;
  readonly revoked: number;
  readonly startMs: number;
  readonly planned: boolean;
  /** From the kill call: the slot handed to the spare (after the hold); the spare launched; the run open there. */
  readonly steps: { handedMs: number; launchedMs: number; openedMs: number };
};

export type CollapseReport = {
  readonly winner: string;
  readonly run: string;
  readonly sealed: { line: string; run: string; ms: number }[];
  readonly ms: number;
};

export type HomeReport = {
  readonly run: string;
  readonly from: string;
  /** Command to the winner's run sealed on the disk and its machine deleted. */
  readonly releasedMs: number;
  /** Command to the run held again where it went (its run.json running at a later generation). */
  readonly attachedMs: number;
};

export type MultiverseErrorCode = "NO_SUCH_UNIVERSE" | "NOT_RUNNING" | "NO_SPARE" | "BUSY" | "START_FAILED" | "NO_WINNER";

export class MultiverseError extends Error {
  readonly code: MultiverseErrorCode;
  constructor(code: MultiverseErrorCode, message: string) {
    super(message);
    this.name = "MultiverseError";
    this.code = code;
  }
}

const ALIVE: readonly UniverseStatus[] = ["starting", "training", "takeover", "winner"];
/** How long a killed tile shows dead before its spare takes the slot, so a camera can read it (the stage's rule). */
export const KILLED_HOLD_MS = 700;

/** `fork` one new run after another (each mounts the source exclusively). */
async function forkEach(source: RunRef, ids: readonly string[], options: ForkOptions) {
  const out: { run: string; ms: number; files: number; bytes: number }[] = [];
  for (const id of ids) {
    const r: ForkResult = await fork(source, id, options);
    out.push({ run: r.run, ms: r.ms, files: r.files, bytes: r.bytes });
  }
  return out;
}

export class Multiverse {
  readonly #o: MultiverseOptions;
  readonly #lines = new Map<string, Line>();
  readonly #now: () => number;
  readonly #log: NonNullable<MultiverseOptions["log"]>;
  readonly #progress: NonNullable<MultiverseOptions["progress"]>;
  #spareSeq = 0;
  #poller: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #ticks = 0;
  #phase: "idle" | "forking" | "running" | "collapsed" | "home" | "closed" = "idle";
  /** Spend of machines a line used and lost before it held its run (they are no longer any line's). */
  #retiredCost = 0;
  /** Set when the fan-out was asked for; cleared once every universe trained (its note is sent then). */
  #fanoutAt: number | null = null;

  constructor(options: MultiverseOptions) {
    if (options.universes.length < 1 || options.universes.length > 8) throw new MultiverseError("NOT_RUNNING", "a multiverse has 1 to 8 universes");
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#progress = options.progress ?? ((run) => readProgressJson(options.control, run));
  }

  get phase() {
    return this.#phase;
  }

  #at(): number {
    return this.#now() - this.#o.origin;
  }

  #patch(line: Line, patch: Partial<Omit<Universe, "id" | "samples" | "lastEventAt">>): void {
    this.#o.emit({ t: "universe", at: this.#at(), id: line.id, patch });
  }

  #note(kind: NoteKind, text: string, measured = false): void {
    this.#o.emit({ t: "note", at: this.#at(), kind, text, ...(measured ? { measured: true } : {}) });
  }

  #newLine(id: string, slot: number | null, status: UniverseStatus): Line {
    const line: Line = { id, slot, status, machine: null, ready: Promise.reject(new Error("no machine yet")), run: null, spec: null, placed: null, stay: null, step: -1, generation: 0, score: null, ended: null, leaving: false };
    line.ready.catch(() => {});
    this.#lines.set(id, line);
    return line;
  }

  /** Ask the fleet for a machine for `line`; the stage learns its host as soon as it is ready. */
  #warm(line: Line): Promise<Machine> {
    const t0 = this.#now();
    line.ready = this.#o.fleet.warm(`${this.#o.machinePrefix}${line.id}`).then((m) => {
      line.machine = m;
      this.#log("machine.ready", { line: line.id, machine: m.id, ms: this.#now() - t0 });
      this.#patch(line, { host: m.label, hostKind: m.kind, ...(line.status === "spare" ? { status: "spare" } : {}) });
      return m;
    });
    line.ready.catch((error: unknown) => this.#log("machine.failed", { line: line.id, error: (error as Error).message }));
    return line.ready;
  }

  #addSpare(): Line {
    const line = this.#newLine(`spare${++this.#spareSeq}`, null, "spare");
    void this.#warm(line).catch(() => {});
    return line;
  }

  #topUpSpares(): void {
    const have = [...this.#lines.values()].filter((l) => l.status === "spare" && l.slot === null).length;
    for (let i = have; i < this.#o.spares; i++) this.#addSpare();
  }

  #env(line: Line, arrival: Arrival): Record<string, string> {
    const spec = line.spec!;
    return {
      ...spec.env,
      UNIVERSE_ID: spec.id,
      UNIVERSE_LINE: line.id,
      UNIVERSE_OF: String(this.#o.universes.length),
      UNIVERSE_REWARD: spec.reward,
      DEMO_ENV_LABEL: line.machine!.label,
      DEMO_SWITCH_ID: arrival.switchId,
      DEMO_SWITCH_FROM: arrival.from,
      DEMO_SWITCH_PLANNED: arrival.planned ? "1" : "0",
    };
  }

  /** Place `line`'s run on its machine; `from` is the placement it replaces. */
  async #place(line: Line, arrival: Arrival, from?: Placed): Promise<PlaceResult> {
    // A machine can die between its create and its use (a sandbox shut down by its provider): the line then takes a
    // ready spare's machine, or a new one, and tries once more. The run is untouched by a placement that never opened.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const machine = await line.ready.catch((error: unknown) => {
        lastError = error;
        return null;
      });
      if (machine) {
        try {
          const result = await this.#o.fleet.place(line.run!, machine, this.#env(line, arrival), from);
          line.placed = result.placed;
          return result;
        } catch (error) {
          lastError = error;
          this.#log("place.failed", { line: line.id, machine: machine.id, attempt, error: (error as Error).message });
          await this.#o.fleet.retire(machine).catch(() => {});
          this.#lineEnded(line);
        }
      } else {
        this.#log("machine.unusable", { line: line.id, attempt, error: (lastError as Error)?.message });
      }
      if (attempt < 2) this.#replaceMachine(line);
    }
    throw new MultiverseError("START_FAILED", `placing ${line.run!.id} failed: ${(lastError as Error)?.message ?? "no machine"}`);
  }

  /** The line's machine is lost before it held the run: its cost ends now. */
  #lineEnded(line: Line): void {
    if (line.machine) this.#retiredCost += this.#cost(line);
  }

  /**
   * Give `line` another machine: a ready spare's (that spare leaves the stage, unseen), else a new one. The stage's tile
   * keeps its slot and learns the new host.
   */
  #replaceMachine(line: Line): void {
    const spare = [...this.#lines.values()].find((l) => l !== line && l.status === "spare" && l.slot === null && l.machine);
    if (spare) {
      spare.status = "sealed";
      this.#patch(spare, { status: "sealed", slot: null });
      this.#lines.delete(spare.id);
      line.machine = spare.machine;
      line.ready = spare.ready;
      this.#patch(line, { host: spare.machine!.label, hostKind: spare.machine!.kind });
      this.#log("machine.replaced", { line: line.id, by: spare.id, machine: spare.machine!.id });
      if (this.#phase === "running" || this.#phase === "forking") this.#topUpSpares();
      return;
    }
    line.machine = null;
    void this.#warm(line).catch(() => {});
    this.#log("machine.rewarmed", { line: line.id });
  }

  #beginStay(line: Line, handover: { fromHost: string; ms: number; planned: boolean }): void {
    line.stay = `${line.id}:${line.machine!.id}`;
    this.#o.emit({ t: "stay.begin", at: this.#at(), stay: { id: line.stay, lane: `u:${line.id}`, host: line.machine!.label, hostKind: line.machine!.kind, from: this.#at(), handover } });
  }

  #endStay(line: Line, endedBy: "switch" | "killed" | "sealed"): void {
    if (!line.stay) return;
    this.#o.emit({ t: "stay.end", at: this.#at(), id: line.stay, endedBy });
    line.stay = null;
  }

  /**
   * Make every universe's machine and the spares now, before the fan-out, so the fan-out waits only on its forks. The
   * stage shows them as idle machines (status spare, no slot) until the fan-out gives each universe its slot.
   */
  prewarm(): void {
    if (this.#phase !== "idle") throw new MultiverseError("BUSY", `the multiverse is ${this.#phase}`);
    for (const spec of this.#o.universes) {
      if (this.#lines.has(spec.id)) continue;
      void this.#warm(this.#newLine(spec.id, null, "starting")).catch(() => {});
    }
    this.#topUpSpares();
  }

  /** Resolves when every machine asked for so far is ready (or failed). */
  async whenWarm(): Promise<void> {
    await Promise.allSettled([...this.#lines.values()].map((l) => l.ready));
  }

  /**
   * Fork the source into every universe and place each on its own machine. Machines are made while the forks copy
   * (unless prewarmed); every universe is placed as soon as the forks are done.
   */
  async fanOut(): Promise<FanOutReport> {
    if (this.#phase !== "idle") throw new MultiverseError("BUSY", `the multiverse is ${this.#phase}`);
    this.#phase = "forking";
    const t0 = this.#now();
    this.#fanoutAt = t0;
    const n = this.#o.universes.length;
    this.#note("story", `Forking into ${n} universes, each on its own machine.`);
    this.#o.emit({ t: "place", at: this.#at(), place: { where: "universes", host: `${n} machines` }, env: "universes" });
    const lines = this.#o.universes.map((spec, slot) => {
      const warmed = this.#lines.get(spec.id);
      const line = warmed ?? this.#newLine(spec.id, slot, "starting");
      line.slot = slot;
      line.status = "starting";
      line.spec = spec;
      line.run = { ...this.#o.source, id: `${this.#o.runPrefix}${spec.id}` };
      this.#patch(line, { slot, status: "starting", reward: spec.reward, progress: 0, cost: 0 });
      if (!warmed) void this.#warm(line).catch(() => {});
      return line;
    });
    this.#topUpSpares();
    const f0 = this.#now();
    const forks = await (this.#o.forkAll ?? forkEach)(
      this.#o.source,
      lines.map((l) => l.run!.id),
      { control: this.#o.control, mountRoot: this.#o.mountRoot, ...(this.#o.forkHost ? { host: this.#o.forkHost } : {}), ...(this.#o.onResource ? { onResource: this.#o.onResource } : {}) },
    );
    const forkMs = this.#now() - f0;
    for (const f of forks) {
      this.#o.onResource?.("run", f.run, `fork of ${this.#o.source.id}`);
      this.#log("fork", f);
    }
    const settled = await Promise.allSettled(
      lines.map(async (line) => {
        const s0 = this.#now();
        const r = await this.#place(line, { switchId: `fanout-${line.run!.id}`, from: this.#o.sourceLabel, planned: true });
        const ms = r.openedAt - s0;
        this.#beginStay(line, { fromHost: this.#o.sourceLabel, ms, planned: true });
        this.#log("start", { line: line.id, run: line.run!.id, machine: line.machine!.id, ms, startMs: r.startMs ?? null });
        return { line: line.id, run: line.run!.id, host: line.machine!.label, ms, startMs: r.startMs ?? null };
      }),
    );
    this.#phase = "running";
    this.#startPolling();
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed.length > 0) {
      for (const f of failed) this.#log("start.failed", { error: (f.reason as Error).message });
      throw new MultiverseError("START_FAILED", `${failed.length} of ${n} universes did not start: ${(failed[0]!.reason as Error).message}`);
    }
    return { forks, forkMs, starts: settled.map((s) => (s as PromiseFulfilledResult<FanOutReport["starts"][number]>).value), ms: this.#now() - t0 };
  }

  #startPolling(): void {
    if (this.#poller) return;
    this.#poller = setInterval(() => void this.poll().catch((error: unknown) => this.#log("poll.failed", { error: (error as Error).message })), this.#o.pollMs ?? 1_000);
    this.#poller.unref?.();
  }

  #cost(line: Line, at = this.#now()): number {
    if (!line.machine) return 0;
    return (line.machine.ratePerHour * Math.max(0, (line.ended ?? at) - line.machine.since)) / 3_600_000;
  }

  /** One pass: each live universe's checkpoint and the fleet's spend; every other pass, a machine that died unasked. */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const checkHosts = this.#ticks++ % 2 === 0;
      const live = [...this.#lines.values()].filter((l) => l.run && ALIVE.includes(l.status) && !l.leaving);
      await Promise.all(
        live.map(async (line) => {
          const p = await this.#progress(line.run!, line.spec!);
          if (p && p.checkpointed !== false && p.step > line.step) {
            line.score = p.score;
            line.step = p.step;
            this.#o.emit({ t: "sample", at: this.#at(), id: line.id, score: p.score, progress: p.progress, cost: round(this.#cost(line)) });
          }
          // A checkpoint written by this line's placement means the universe trains here.
          if (p && p.checkpointed !== false && (line.status === "starting" || line.status === "takeover") && this.#ownCheckpoint(line, p)) {
            line.status = "training";
            line.generation = Math.max(line.generation, p.generation);
            this.#patch(line, { status: "training", startedAt: this.#at() });
          }
          if (checkHosts && line.placed && !line.leaving) {
            const status: HostStatus = await this.#o.fleet.status(line.placed).catch(() => "unknown" as const);
            if ((status === "gone" || status === "stopped" || status === "failed") && !line.leaving) {
              this.#log("machine.lost", { line: line.id, status });
              void this.#replace(line, { planned: false, t0: this.#now(), kill: false, why: `${line.machine!.label} stopped (${status})` }).catch((error: unknown) => this.#log("takeover.failed", { line: line.id, error: (error as Error).message }));
            }
          }
        }),
      );
      this.#fanoutNote();
      this.#emitCost();
    } finally {
      this.#polling = false;
    }
  }

  /**
   * Whether `p` was written by `line`'s own placement: it names the line's machine; or, for a workload that cannot know
   * the label, the line is starting a fresh fork (nothing else wrote its run), or `p` is of a later generation than the
   * run had when the line took it over.
   */
  #ownCheckpoint(line: Line, p: Progress): boolean {
    if (p.host && p.host === line.machine?.label) return true;
    return line.status === "starting" || p.generation > line.generation;
  }

  /** Once every universe trains, the measured time from the fan-out command. */
  #fanoutNote(): void {
    if (this.#fanoutAt === null || this.#phase !== "running") return;
    const slotted = [...this.#lines.values()].filter((l) => l.slot !== null);
    if (slotted.length === 0 || !slotted.every((l) => l.status === "training")) return;
    const s = ((this.#now() - this.#fanoutAt) / 1000).toFixed(1);
    this.#fanoutAt = null;
    this.#note("story", `${slotted.length} machines training ${s} s after the fan-out.`, true);
  }

  #emitCost(): void {
    const now = this.#now();
    let usd = this.#retiredCost;
    let perHour = 0;
    for (const line of this.#lines.values()) {
      usd += this.#cost(line, now);
      if (line.machine && line.ended === null) perHour += line.machine.ratePerHour;
    }
    const cost: Cost = { usd: round(usd), ratePerMin: round(perHour / 60) };
    this.#o.emit({ t: "cost", at: this.#at(), cost });
  }

  /**
   * The kill button: power off the universe's machine and place its run on a warm spare, which takes the universe's
   * slot. Resolves when the spare has the run open and has written its first checkpoint (or a minute passed).
   */
  async kill(lineId: string): Promise<TakeoverReport> {
    const line = this.#lines.get(lineId);
    if (!line) throw new MultiverseError("NO_SUCH_UNIVERSE", `no universe ${lineId}`);
    if (!line.run || !line.machine || !line.placed || !ALIVE.includes(line.status) || line.status === "winner" || line.leaving) {
      throw new MultiverseError("NOT_RUNNING", `${lineId} is ${line.status}`);
    }
    return this.#replace(line, { planned: false, t0: this.#now(), kill: true, why: `${line.machine.label}, which was killed` });
  }

  /**
   * Move `line`'s run to a spare: reserve the spare at once (a second kill cannot claim it), kill the machine when asked
   * and place the run on the spare at the same time (the fleet's transport keeps one writer), show the dead tile for
   * `KILLED_HOLD_MS` while that runs, then hand the spare the slot. The spare's tile turns `training` at its first
   * checkpoint (the poll).
   */
  async #replace(line: Line, how: { planned: boolean; t0: number; kill: boolean; why: string }): Promise<TakeoverReport> {
    line.leaving = true;
    const spare = this.#reserveSpare(line);
    line.status = "killed";
    this.#patch(line, { status: "killed" });
    this.#endStay(line, "killed");
    this.#note("kill", how.kill ? `${line.machine!.label} was killed.` : `${how.why}.`);
    const run = line.run!;
    const from = line.placed!;
    const killing = (how.kill ? this.#o.fleet.kill(line.machine!) : this.#o.fleet.kill(line.machine!).catch(() => {})).then(() => this.#now() - how.t0);
    try {
      await spare.ready;
    } catch (error) {
      throw new MultiverseError("NO_SPARE", `no spare machine for ${line.id}: ${(error as Error).message}`);
    }
    spare.run = run;
    spare.spec = line.spec;
    spare.step = line.step;
    spare.generation = line.generation;
    void this.#refill();
    const arrival: Arrival = { switchId: `takeover-${run.id}-${spare.id}`, from: how.why, planned: how.planned };
    // The spare is placed now; the stage's dead tile is held for its own sake, in parallel, not on the takeover's clock.
    const placing = this.#place(spare, arrival, from);
    placing.catch(() => {});
    await sleep(how.t0 + KILLED_HOLD_MS - this.#now());
    spare.slot = line.slot;
    const handed = this.#now();
    this.#patch(spare, { slot: line.slot, status: "takeover", reward: line.spec!.reward, replaces: line.id, progress: 0 });
    this.#patch(line, { slot: null, replacedBy: spare.id });
    line.slot = null;
    const [killMs, result] = await Promise.all([killing, placing]);
    line.ended ??= this.#now();
    const openMs = result.openedAt - how.t0;
    this.#beginStay(spare, { fromHost: line.machine!.label, ms: openMs, planned: how.planned });
    const trained = await this.#waitCheckpoint(spare, this.#o.resumeTimeoutMs ?? 60_000);
    const resumedMs = trained === null ? null : trained - how.t0;
    this.#note(
      "takeover",
      `${spare.machine!.label} took over universe ${spare.spec!.id}: run open ${openMs} ms after the kill${resumedMs === null ? "" : `, training again from its last checkpoint at ${resumedMs} ms`}.`,
      true,
    );
    const report: TakeoverReport = {
      killed: line.id,
      by: spare.id,
      run: run.id,
      transport: this.#o.fleet.transport,
      openMs,
      trainingMs: resumedMs,
      killMs,
      revoked: result.revoked,
      startMs: result.startMs ?? 0,
      planned: how.planned,
      steps: { handedMs: handed - how.t0, launchedMs: result.launchedAt - how.t0, openedMs: openMs },
    };
    this.#log("takeover", report);
    return report;
  }

  /**
   * Claim a spare for `killed` now, synchronously: a ready one first, else one still warming, else a new one (the slow
   * path, a machine made on demand). The stage sees it reserved (`takeover`, `replaces`) before it gets the slot.
   */
  #reserveSpare(killed: Line): Line {
    const spares = [...this.#lines.values()].filter((l) => l.status === "spare" && l.slot === null);
    const line = spares.find((l) => l.machine) ?? spares[0] ?? this.#addSpare();
    line.status = "takeover";
    this.#patch(line, { status: "takeover", replaces: killed.id });
    return line;
  }

  async #refill(): Promise<void> {
    if (this.#phase === "running") this.#topUpSpares();
  }

  /** The first checkpoint the spare's machine writes. */
  async #waitCheckpoint(line: Line, timeoutMs: number): Promise<number | null> {
    const deadline = this.#now() + timeoutMs;
    while (this.#now() < deadline) {
      const p = await this.#progress(line.run!, line.spec!);
      if (p && p.checkpointed !== false && this.#ownCheckpoint(line, p)) {
        if (line.status === "takeover") await this.poll();
        return this.#now();
      }
      await sleep(200);
    }
    return null;
  }

  /**
   * Keep one universe (the best score unless named) and seal the rest: each loser's run is drained and sealed and its
   * machine deleted; unused spares are deleted.
   */
  async collapse(winnerId?: string): Promise<CollapseReport> {
    if (this.#phase !== "running") throw new MultiverseError("BUSY", `the multiverse is ${this.#phase}`);
    const t0 = this.#now();
    const live = [...this.#lines.values()].filter((l) => l.slot !== null && l.placed && (l.status === "training" || l.status === "starting"));
    const winner = winnerId ? this.#lines.get(winnerId) : live.filter((l) => l.score !== null).sort((a, b) => b.score! - a.score!)[0];
    if (!winner || !live.includes(winner)) throw new MultiverseError("NO_WINNER", winnerId ? `${winnerId} is not a running universe` : "no universe has a score yet");
    this.#phase = "collapsed";
    winner.status = "winner";
    this.#patch(winner, { status: "winner" });
    this.#note("winner", `Universe ${winner.spec!.id} wins with ${winner.score?.toFixed(3) ?? "no score"}: ${winner.spec!.reward}. The rest are sealed.`, this.#o.scoresMeasured === true);
    const sealed = await Promise.all(
      live
        .filter((l) => l !== winner)
        .map(async (line) => {
          const s0 = this.#now();
          line.leaving = true;
          await this.#o.fleet.seal(line.placed!).catch((error: unknown) => this.#log("seal.failed", { line: line.id, error: (error as Error).message }));
          line.ended = this.#now();
          line.status = "sealed";
          this.#patch(line, { status: "sealed" });
          this.#endStay(line, "sealed");
          return { line: line.id, run: line.run!.id, ms: this.#now() - s0 };
        }),
    );
    await this.#retireSpares();
    this.#emitCost();
    const report: CollapseReport = { winner: winner.id, run: winner.run!.id, sealed, ms: this.#now() - t0 };
    this.#note("story", `Collapse took ${(report.ms / 1000).toFixed(1)} s: ${sealed.length} ${sealed.length === 1 ? "universe" : "universes"} sealed on the disk.`, true);
    this.#log("collapse", report);
    return report;
  }

  async #retireSpares(): Promise<void> {
    await Promise.all(
      [...this.#lines.values()]
        .filter((l) => l.status === "spare")
        .map(async (line) => {
          const m = await line.ready.catch(() => null);
          if (m) await this.#o.fleet.retire(m).catch((error: unknown) => this.#log("retire.failed", { line: line.id, error: (error as Error).message }));
          line.ended = this.#now();
          line.status = "sealed";
          this.#patch(line, { status: "sealed", slot: null });
        }),
    );
  }

  /**
   * The move home: the winner's run is drained and sealed on the disk and its machine deleted, and the stage sees it
   * moving; it is home once its run.json is running again at a later generation, held by whoever attached it there
   * (the tab, through browser-demo's server). The handover is measured from the command to that run.json.
   */
  async home(target: { label: string; env: string; timeoutMs?: number; onSealed?: (run: RunRef, universe: string) => Promise<void> }): Promise<HomeReport> {
    if (this.#phase !== "collapsed") throw new MultiverseError("BUSY", `the multiverse is ${this.#phase}; home follows the collapse`);
    const w = [...this.#lines.values()].find((l) => l.status === "winner");
    if (!w?.placed || w.ended !== null) throw new MultiverseError("NO_WINNER", "no winner holds a run to bring home");
    this.#phase = "home";
    const t0 = this.#now();
    this.#o.emit({ t: "place", at: this.#at(), place: { where: "moving", to: target.label, host: w.machine!.label }, env: null });
    this.#note("switch", `Universe ${w.spec!.id} is going home to ${target.label}.`);
    await this.#o.fleet.seal(w.placed);
    w.ended = this.#now();
    const releasedMs = this.#now() - t0;
    this.#endStay(w, "switch");
    const sealed = await readRunStatus(this.#o.control, w.run!.id).catch(() => null);
    this.#log("home.released", { run: w.run!.id, ms: releasedMs, status: sealed?.status, generation: sealed?.generation });
    // Whoever brings it home (the tab's server, adopting the run by id) is told now that it is sealed.
    await target.onSealed?.(w.run!, w.spec!.id);
    const deadline = this.#now() + (target.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const r = await readRunStatus(this.#o.control, w.run!.id).catch(() => null);
      if (r && r.status === "running" && r.generation > (sealed?.generation ?? 0)) break;
      if (this.#now() > deadline) throw new MultiverseError("START_FAILED", `${target.label} did not attach ${w.run!.id} in time; it waits sealed on the disk`);
      await sleep(200);
    }
    const attachedMs = this.#now() - t0;
    this.#o.emit({ t: "place", at: this.#at(), place: { where: "home", host: target.label }, env: target.env });
    this.#o.emit({ t: "stay.begin", at: this.#at(), stay: { id: `run:home:${w.run!.id}`, lane: "run", host: target.label, hostKind: "tab", from: this.#at(), handover: { fromHost: w.machine!.label, ms: attachedMs, planned: true } } });
    this.#note("home", `Home: ${target.label} holds universe ${w.spec!.id}'s run ${(attachedMs / 1000).toFixed(1)} s after it left ${w.machine!.label}.`, true);
    const report: HomeReport = { run: w.run!.id, from: w.machine!.label, releasedMs, attachedMs };
    this.#log("home", report);
    return report;
  }

  /** The winner's run and where it is, for the move home. */
  winner(): { line: string; placed: Placed } | null {
    const w = [...this.#lines.values()].find((l) => l.status === "winner");
    return w?.placed ? { line: w.id, placed: w.placed } : null;
  }

  /** The machine a line holds, once ready. */
  machine(lineId: string): Machine | null {
    return this.#lines.get(lineId)?.machine ?? null;
  }

  /** Each line as this process sees it (for logs and tests). */
  lines(): { id: string; slot: number | null; status: UniverseStatus; run: string | null; machine: string | null; step: number; generation: number }[] {
    return [...this.#lines.values()].map((l) => ({ id: l.id, slot: l.slot, status: l.status, run: l.run?.id ?? null, machine: l.machine?.id ?? null, step: l.step, generation: l.generation }));
  }

  /** Stop polling; with `machines`, seal every placed run and delete every machine this multiverse made. */
  async close(options: { machines?: boolean } = {}): Promise<void> {
    if (this.#poller) clearInterval(this.#poller);
    this.#poller = null;
    this.#phase = "closed";
    if (!options.machines) return;
    await Promise.all(
      [...this.#lines.values()].map(async (line) => {
        if (line.ended !== null) return;
        if (line.placed) await this.#o.fleet.seal(line.placed).catch(() => {});
        else {
          // A machine still being made may never be: its fleet's sweep finds it; a close does not wait past a bound.
          const m = await Promise.race([line.ready.catch(() => null), sleep(30_000).then(() => null)]);
          if (m) await this.#o.fleet.retire(m).catch(() => {});
        }
        line.ended = this.#now();
      }),
    );
  }
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
