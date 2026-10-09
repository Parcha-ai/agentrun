// The multiverse: one sealed run forked into N universes, each started on its own machine through a host driver, watched
// over the disk's S3 API, a killed machine's universe taken over by a warm spare, and the collapse that keeps one
// universe running and seals the rest. Host-agnostic: machines come from a `Fleet` (Daytona boxes, Modal sandboxes),
// runs move only through the package's claim (fork, ensureRunning, revoke), and every change the stage draws is a
// ShowEvent (show/types.ts), so the panel is the fold of what happened here.
//
// Invariants:
//   - A universe's run has one writer: a takeover revokes the dead holder's delegation before the spare mounts, and the
//     fence is Archil's, so a holder that was not quite dead commits nothing after it.
//   - The orchestrator never mounts a universe's run; it reads `run.json` and `work/universe/progress.json` over S3 and
//     mounts only the source and each new run while forking them (`fork`).
//   - A show line is one machine's life in the grid: a spare that takes over a killed universe becomes that universe's
//     line in the same slot (`replaces`), as the stage's contract says.
import type { ArchilHost, PathlessResolver, CheckControl, ControlApi, EnsureOptions, EnsureResult, HostDriver, HostHandle, HostStatus, RunRecord, RunRef, SupervisorControl } from "@parcha/pi-durable-disk";
import { ensureRunning, findDelegations, fork, pathlessResolver, readRunStatus, revoke, runPath } from "@parcha/pi-durable-disk";
import type { Cost, HostKind, ShowEvent, Universe, UniverseStatus } from "./show/types.ts";

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

/** Where universes run. A driver from `driver` starts a run on that machine, which it already holds ready. */
export interface Fleet {
  /** Create a machine and make it ready to take a run: started, set up, no claim and no mount. */
  warm(name: string): Promise<Machine>;
  /** A driver whose next `start` runs the run on `machine` with this environment (the universe and its arrival). */
  driver(machine: Machine, env: Readonly<Record<string, string>>): HostDriver;
  /** Power the machine off now: the instance gets no drain, the way a machine dies. */
  kill(machine: Machine): Promise<void>;
  /** Delete a machine that holds no run (a spare nobody needed). */
  retire(machine: Machine): Promise<void>;
}

export interface UniverseSpec {
  /** The stage's id for the universe's first line ("u0" .. "u7"). */
  readonly id: string;
  /** The reward variant it trains against, one short line. */
  readonly reward: string;
  /** Extra environment for its instance (trainer settings). */
  readonly env?: Readonly<Record<string, string>>;
}

/** What a universe's instance writes after each checkpoint (and runs the claim's barrier on): `work/universe/progress.json`. */
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
}

export const PROGRESS_FILE = "work/universe/progress.json";

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
  /** Supervisor settings for each start (lease expiry, start grace, token prefix). */
  readonly ensure?: Omit<EnsureOptions, "control" | "demand">;
  /** How often runs are read over S3. Default 1 s. */
  readonly pollMs?: number;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
  /** Every disk resource this process creates or removes (fork tokens, mounts, run directories). */
  readonly onResource?: (kind: string, id: string, note?: string) => void;
  readonly now?: () => number;
  /** The package's run operations; replaceable so tests can script the disk. */
  readonly ops?: Partial<RunOps>;
}

/** The package calls the multiverse makes on runs. */
export interface RunOps {
  fork: typeof fork;
  ensureRunning: typeof ensureRunning;
  revoke: typeof revoke;
  readRunStatus: typeof readRunStatus;
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
  driver: HostDriver | null;
  handle: HostHandle | null;
  stay: string | null;
  /** The last checkpoint step seen, and the generation that wrote it. */
  step: number;
  generation: number;
  score: number | null;
  /** Wall ms the machine stopped costing (killed, retired, stopped). */
  ended: number | null;
  /** Set while this process is killing or replacing its machine, so a poll does not take it over twice. */
  leaving: boolean;
}

export type FanOutReport = {
  readonly forks: { run: string; ms: number; files: number; bytes: number }[];
  readonly starts: { line: string; run: string; host: string; ms: number; startMs: number | null }[];
  readonly ms: number;
};

export type TakeoverReport = {
  readonly killed: string;
  readonly by: string;
  readonly run: string;
  /** Kill call made to the replacement's instance open (run.json at its new generation, its holder). */
  readonly openMs: number;
  /** ...to the replacement's first checkpoint. */
  readonly trainingMs: number | null;
  readonly killMs: number;
  readonly revoked: number;
  readonly startMs: number;
  readonly generation: number;
  readonly planned: boolean;
  /** From the kill call: revoked; slot handed to the spare (after the hold); its instance launched; the run open. */
  readonly steps: { revokedMs: number; handedMs: number; launchedMs: number; openedMs: number };
};

export type CollapseReport = {
  readonly winner: string;
  readonly run: string;
  readonly sealed: { line: string; run: string; status: string; sealedSeq: number | null; ms: number }[];
  readonly ms: number;
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

export class Multiverse {
  readonly #o: MultiverseOptions;
  readonly #ops: RunOps;
  readonly #lines = new Map<string, Line>();
  readonly #now: () => number;
  readonly #log: NonNullable<MultiverseOptions["log"]>;
  #spareSeq = 0;
  #poller: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #ticks = 0;
  #phase: "idle" | "forking" | "running" | "collapsed" | "closed" = "idle";
  /** One resolver for every decision: a pathless delegation's run is looked up once (an exec), not once per start. */
  readonly #pathless: PathlessResolver;

  constructor(options: MultiverseOptions) {
    if (options.universes.length < 1 || options.universes.length > 8) throw new MultiverseError("NOT_RUNNING", "a multiverse has 1 to 8 universes");
    this.#o = options;
    this.#ops = { fork, ensureRunning, revoke, readRunStatus, ...options.ops };
    this.#pathless = options.ensure?.pathless ?? pathlessResolver(options.control);
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
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

  #note(kind: "story" | "switch" | "kill" | "takeover" | "winner" | "home", text: string): void {
    this.#o.emit({ t: "note", at: this.#at(), kind, text });
  }

  #newLine(id: string, slot: number | null, status: UniverseStatus): Line {
    const line: Line = { id, slot, status, machine: null, ready: Promise.reject(new Error("no machine yet")), run: null, spec: null, driver: null, handle: null, stay: null, step: -1, generation: 0, score: null, ended: null, leaving: false };
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

  /** Start `line`'s run on its machine through the supervisor. */
  async #start(line: Line, arrival: Arrival): Promise<Extract<EnsureResult, { action: "started" }>> {
    const machine = await line.ready;
    const driver = this.#o.fleet.driver(machine, this.#env(line, arrival));
    const result = await this.#ops.ensureRunning(line.run!, driver, { ...this.#o.ensure, control: this.#o.control, pathless: this.#pathless, demand: true });
    if (result.action !== "started") throw new MultiverseError("START_FAILED", `the supervisor did not start ${line.run!.id}: ${result.action}`);
    this.#o.onResource?.("token", result.token.identifier, result.token.nickname);
    line.driver = driver;
    line.handle = result.handle;
    return result;
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
    this.#warmResolver();
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

  /** Attribute the disk's pathless delegations now (one exec), off every start's clock. */
  #warmResolver(): void {
    if (this.#o.ops?.revoke) return;
    void findDelegations(this.#o.control, this.#o.source.id, this.#pathless).catch((error: unknown) => this.#log("pathless.failed", { error: (error as Error).message }));
  }

  #topUpSpares(): void {
    const have = [...this.#lines.values()].filter((l) => l.status === "spare" && l.slot === null).length;
    for (let i = have; i < this.#o.spares; i++) this.#addSpare();
  }

  /**
   * Fork the source into every universe and start each on its own machine. Machines are made while the forks copy;
   * each universe starts as soon as its fork is done. Forks run one after another (each mounts the source exclusively).
   */
  async fanOut(): Promise<FanOutReport> {
    if (this.#phase !== "idle") throw new MultiverseError("BUSY", `the multiverse is ${this.#phase}`);
    this.#phase = "forking";
    this.#warmResolver();
    const t0 = this.#now();
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
    const forks: FanOutReport["forks"] = [];
    const starts: Promise<FanOutReport["starts"][number]>[] = [];
    for (const line of lines) {
      const f0 = this.#now();
      const r = await this.#ops.fork(this.#o.source, line.run!.id, { control: this.#o.control, mountRoot: this.#o.mountRoot, ...(this.#o.forkHost ? { host: this.#o.forkHost } : {}), ...(this.#o.onResource ? { onResource: this.#o.onResource } : {}) });
      forks.push({ run: r.run, ms: this.#now() - f0, files: r.files, bytes: r.bytes });
      this.#o.onResource?.("run", r.run, `fork of ${this.#o.source.id}`);
      this.#log("fork", { run: r.run, ms: this.#now() - f0, files: r.files, bytes: r.bytes, sealedSeq: r.sealedSeq });
      const arrival: Arrival = { switchId: `fanout-${line.run!.id}`, from: this.#o.sourceLabel, planned: true };
      starts.push(
        (async () => {
          const s0 = this.#now();
          const result = await this.#start(line, arrival);
          const ms = this.#now() - s0;
          this.#beginStay(line, { fromHost: this.#o.sourceLabel, ms, planned: true });
          this.#log("start", { line: line.id, run: line.run!.id, machine: line.machine!.id, ms, startMs: result.startMs ?? null });
          return { line: line.id, run: line.run!.id, host: line.machine!.label, ms, startMs: result.startMs ?? null };
        })(),
      );
    }
    const settled = await Promise.allSettled(starts);
    this.#phase = "running";
    this.#startPolling();
    const failed = settled.filter((s) => s.status === "rejected");
    if (failed.length > 0) {
      for (const f of failed) this.#log("start.failed", { error: ((f as PromiseRejectedResult).reason as Error).message });
      throw new MultiverseError("START_FAILED", `${failed.length} of ${n} universes did not start: ${((failed[0] as PromiseRejectedResult).reason as Error).message}`);
    }
    return { forks, starts: settled.map((s) => (s as PromiseFulfilledResult<FanOutReport["starts"][number]>).value), ms: this.#now() - t0 };
  }

  #startPolling(): void {
    if (this.#poller) return;
    this.#poller = setInterval(() => void this.poll().catch((error: unknown) => this.#log("poll.failed", { error: (error as Error).message })), this.#o.pollMs ?? 1_000);
    this.#poller.unref?.();
  }

  async #readProgress(run: RunRef): Promise<Progress | null> {
    try {
      const bytes = await this.#o.control.getObject(`${runPath(run.id)}/${PROGRESS_FILE}`);
      return JSON.parse(new TextDecoder().decode(bytes)) as Progress;
    } catch {
      return null;
    }
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
          const p = await this.#readProgress(line.run!);
          if (p && (p.step > line.step || p.generation > line.generation)) {
            const first = line.status === "starting" || line.status === "takeover";
            if (p.step > line.step) {
              line.score = p.score;
              this.#o.emit({ t: "sample", at: this.#at(), id: line.id, score: p.score, progress: p.progress, cost: round(this.#cost(line)) });
            }
            line.step = Math.max(line.step, p.step);
            line.generation = Math.max(line.generation, p.generation);
            // A checkpoint written on this line's machine means the universe trains here.
            if (first && p.host === line.machine?.label) {
              line.status = "training";
              this.#patch(line, { status: "training", startedAt: this.#at() });
            }
          }
          if (checkHosts && line.driver && line.handle && !line.leaving) {
            const status: HostStatus = await line.driver.status(line.handle).catch(() => "unknown" as const);
            if ((status === "gone" || status === "stopped" || status === "failed") && !line.leaving) {
              this.#log("machine.lost", { line: line.id, status });
              void this.#replace(line, { planned: false, t0: this.#now(), kill: false, why: `${line.machine!.label} stopped (${status})` }).catch((error: unknown) => this.#log("takeover.failed", { line: line.id, error: (error as Error).message }));
            }
          }
        }),
      );
      this.#emitCost();
    } finally {
      this.#polling = false;
    }
  }

  #emitCost(): void {
    const now = this.#now();
    let usd = 0;
    let perHour = 0;
    for (const line of this.#lines.values()) {
      usd += this.#cost(line, now);
      if (line.machine && line.ended === null) perHour += line.machine.ratePerHour;
    }
    const cost: Cost = { usd: round(usd), ratePerMin: round(perHour / 60) };
    this.#o.emit({ t: "cost", at: this.#at(), cost });
  }

  /**
   * The kill button: power off the universe's machine, revoke its claim, and start its run on a warm spare, which takes
   * the universe's slot. Resolves when the spare's instance has opened the run.
   */
  async kill(lineId: string): Promise<TakeoverReport> {
    const line = this.#lines.get(lineId);
    if (!line) throw new MultiverseError("NO_SUCH_UNIVERSE", `no universe ${lineId}`);
    if (!line.run || !line.machine || !ALIVE.includes(line.status) || line.status === "winner" || line.leaving) {
      throw new MultiverseError("NOT_RUNNING", `${lineId} is ${line.status}`);
    }
    return this.#replace(line, { planned: false, t0: this.#now(), kill: true, why: `${line.machine.label}, which was killed` });
  }

  /**
   * Move `line`'s run to a spare: reserve the spare at once (a second kill cannot claim it), kill the machine when asked,
   * revoke the old claim, show the dead tile for `KILLED_HOLD_MS`, hand the spare the slot, start the run there and wait
   * for its instance to open. The spare's tile turns `training` at its first checkpoint (the poll).
   */
  async #replace(line: Line, how: { planned: boolean; t0: number; kill: boolean; why: string }): Promise<TakeoverReport> {
    line.leaving = true;
    const spare = this.#reserveSpare(line);
    line.status = "killed";
    this.#patch(line, { status: "killed" });
    this.#endStay(line, "killed");
    this.#note("kill", how.kill ? `${line.machine!.label} was killed.` : `${how.why}.`);
    const run = line.run!;
    const before = await this.#ops.readRunStatus(this.#o.control, run.id).catch(() => null);
    const killing = how.kill ? this.#o.fleet.kill(line.machine!).then(() => this.#now() - how.t0) : Promise.resolve(0);
    // The holder is dead or about to be: its delegation goes now, so the spare's mount does not wait on a lease, and a
    // holder that is not quite dead is fenced at its next write.
    const [killMs, revoked] = await Promise.all([killing, this.#ops.revoke(this.#o.control, run.id)]);
    line.ended ??= this.#now();
    if (!how.kill) void this.#o.fleet.kill(line.machine!).catch(() => {});
    const revokedAt = this.#now();
    this.#log("revoked", { line: line.id, run: run.id, delegations: revoked.length, killMs, ms: revokedAt - how.t0 });
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
    // The spare starts now; the stage's dead tile is held for its own sake, in parallel, not on the takeover's clock.
    const arrival: Arrival = { switchId: `takeover-${run.id}-${spare.id}`, from: how.why, planned: how.planned };
    const starting = this.#start(spare, arrival).then((r) => ({ r, at: this.#now() }));
    starting.catch(() => {});
    await sleep(how.t0 + KILLED_HOLD_MS - this.#now());
    spare.slot = line.slot;
    const handed = this.#now();
    this.#patch(spare, { slot: line.slot, status: "takeover", reward: line.spec!.reward, replaces: line.id, progress: 0 });
    this.#patch(line, { slot: null, replacedBy: spare.id });
    line.slot = null;
    const { r: result, at: launched } = await starting;
    const opened = await this.#waitOpen(run, spare, (before?.generation ?? line.generation) + 1);
    const openMs = opened.at - how.t0;
    this.#beginStay(spare, { fromHost: line.machine!.label, ms: openMs, planned: how.planned });
    const trained = await this.#waitCheckpoint(spare, opened.generation, 60_000);
    const resumedMs = trained === null ? null : trained - how.t0;
    this.#note(
      "takeover",
      `${spare.machine!.label} took over universe ${spare.spec!.id}: run open ${openMs} ms after the kill, training again from its last checkpoint at ${resumedMs ?? "?"} ms (measured).`,
    );
    const report: TakeoverReport = {
      killed: line.id,
      by: spare.id,
      run: run.id,
      openMs,
      trainingMs: resumedMs,
      killMs,
      revoked: revoked.length,
      startMs: result.startMs ?? 0,
      generation: opened.generation,
      planned: how.planned,
      steps: { revokedMs: revokedAt - how.t0, handedMs: handed - how.t0, launchedMs: launched - how.t0, openedMs: openMs },
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

  /** run.json written by the new instance: its generation reached, held by the spare's machine. */
  async #waitOpen(run: RunRef, spare: Line, generation: number, timeoutMs = 120_000): Promise<{ at: number; generation: number; record: RunRecord }> {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      const record = await this.#ops.readRunStatus(this.#o.control, run.id).catch(() => null);
      if (record && record.status === "running" && record.generation >= generation) return { at: this.#now(), generation: record.generation, record };
      if (this.#now() > deadline) throw new MultiverseError("START_FAILED", `${run.id} did not open on ${spare.machine?.label} in ${timeoutMs} ms`);
      await sleep(100);
    }
  }

  async #waitCheckpoint(line: Line, generation: number, timeoutMs: number): Promise<number | null> {
    const deadline = this.#now() + timeoutMs;
    while (this.#now() < deadline) {
      const p = await this.#readProgress(line.run!);
      if (p && p.generation >= generation && p.host === line.machine?.label) {
        if (line.status === "takeover") await this.poll();
        return this.#now();
      }
      await sleep(200);
    }
    return null;
  }

  /**
   * Keep one universe (the best score unless named) and seal the rest: each loser's instance drains, seals its run.json
   * with the store's last sequence and leaves its machine, which is deleted; unused spares are deleted.
   */
  async collapse(winnerId?: string): Promise<CollapseReport> {
    if (this.#phase !== "running") throw new MultiverseError("BUSY", `the multiverse is ${this.#phase}`);
    const t0 = this.#now();
    const live = [...this.#lines.values()].filter((l) => l.slot !== null && l.run && (l.status === "training" || l.status === "starting"));
    const winner = winnerId ? this.#lines.get(winnerId) : live.filter((l) => l.score !== null).sort((a, b) => b.score! - a.score!)[0];
    if (!winner || !live.includes(winner)) throw new MultiverseError("NO_WINNER", winnerId ? `${winnerId} is not a running universe` : "no universe has a score yet");
    this.#phase = "collapsed";
    winner.status = "winner";
    this.#patch(winner, { status: "winner" });
    this.#note("winner", `Universe ${winner.spec!.id} wins with ${winner.score?.toFixed(3) ?? "no score"}: ${winner.spec!.reward}. The rest are sealed.`);
    const sealed = await Promise.all(
      live
        .filter((l) => l !== winner)
        .map(async (line) => {
          const s0 = this.#now();
          line.leaving = true;
          await line.driver!.stop(line.handle!).catch((error: unknown) => this.#log("seal.stop-failed", { line: line.id, error: (error as Error).message }));
          line.ended = this.#now();
          const record = await this.#ops.readRunStatus(this.#o.control, line.run!.id).catch(() => null);
          line.status = "sealed";
          this.#patch(line, { status: "sealed" });
          this.#endStay(line, "sealed");
          return { line: line.id, run: line.run!.id, status: record?.status ?? "unknown", sealedSeq: record?.sealedSeq ?? null, ms: this.#now() - s0 };
        }),
    );
    await this.#retireSpares();
    this.#emitCost();
    const report: CollapseReport = { winner: winner.id, run: winner.run!.id, sealed, ms: this.#now() - t0 };
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
          this.#patch(line, { status: "sealed" });
        }),
    );
  }

  /** The winner's run and where it is, for the move home. */
  winner(): { line: string; run: RunRef; machine: Machine; handle: HostHandle; driver: HostDriver } | null {
    const w = [...this.#lines.values()].find((l) => l.status === "winner");
    return w && w.run && w.machine && w.handle && w.driver ? { line: w.id, run: w.run, machine: w.machine, handle: w.handle, driver: w.driver } : null;
  }

  /** The machine a line holds, once ready. */
  machine(lineId: string): Machine | null {
    return this.#lines.get(lineId)?.machine ?? null;
  }

  /** Each line as this process sees it (for logs and tests). */
  lines(): { id: string; slot: number | null; status: UniverseStatus; run: string | null; machine: string | null; step: number; generation: number }[] {
    return [...this.#lines.values()].map((l) => ({ id: l.id, slot: l.slot, status: l.status, run: l.run?.id ?? null, machine: l.machine?.id ?? null, step: l.step, generation: l.generation }));
  }

  /** Stop polling; with `machines`, stop every instance (drained) and delete every machine this multiverse made. */
  async close(options: { machines?: boolean } = {}): Promise<void> {
    if (this.#poller) clearInterval(this.#poller);
    this.#poller = null;
    this.#phase = "closed";
    if (!options.machines) return;
    await Promise.all(
      [...this.#lines.values()].map(async (line) => {
        if (line.driver && line.handle && line.ended === null) await line.driver.stop(line.handle).catch(() => {});
        else if (line.ended === null) {
          const m = await line.ready.catch(() => null);
          if (m) await this.#o.fleet.retire(m).catch(() => {});
        }
        line.ended ??= this.#now();
      }),
    );
  }
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
