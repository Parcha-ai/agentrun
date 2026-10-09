// The scripted feed: a four-minute "It Walks Home" run as ShowEvents, for rehearsal, tests and recording. It is a small
// simulation, not a replay: a `kill` command at any moment during training makes a spare take over, so the kill is
// live on camera. Invariants:
//   - Time is a number the caller advances (`advance(ms)`); only `start()` binds it to a wall clock, so tests step it.
//   - The same seed and the same commands at the same times give the same events.
//   - Every event it emits is a valid input to reduce.ts; it never mutates state itself, it only emits.
import { emptyState, reduce } from "./reduce.ts";
import type { Cost, HostKind, Place, ShowCommand, ShowEvent, ShowState, Universe } from "./types.ts";

export type ScenarioOptions = {
  seed?: number;
  /** Seconds of scenario time each phase takes; the defaults make a ~3 min 50 s run. */
  tabSeconds?: number;
  sandboxSeconds?: number;
  vmSeconds?: number;
  trainSeconds?: number;
  /** Kill one universe by itself at this scenario second of training (null: wait for a `kill` command). */
  autoKillAfter?: number | null;
  /** Seconds a spare takes over after a kill: the on-camera "about 2 s". */
  takeoverSeconds?: number;
  /** Milliseconds the killed tile stays visibly dead before the spare claims it, so a camera can read it. */
  killedHoldMs?: number;
  checkpointSeconds?: number;
  universes?: number;
  spares?: number;
  /** Fake prices in USD per hour, to give the cost meter plausible numbers. They are not quotes. */
  rates?: { sandbox: number; vm: number; gpu: number };
  /** Wall-clock ms of time 0 (default Date.now()). */
  origin?: number;
};

const ENVIRONMENTS: ShowState["environments"] = [
  { id: "tab", label: "Browser tab", kind: "tab" },
  { id: "sandbox", label: "Modal sandbox", kind: "sandbox" },
  { id: "vm", label: "Modal VM", kind: "vm" },
  { id: "gpu", label: "8 Modal GPUs", kind: "gpu" },
  { id: "home", label: "Home (tab)", kind: "tab" },
];

const REWARDS = [
  "forward speed + upright bonus",
  "speed, penalize joint torque",
  "stay upright, then speed",
  "speed, smooth footfalls",
  "gait symmetry first",
  "energy-efficient walk",
  "speed on rough terrain",
  "recover from pushes",
  "low center of mass",
  "long stride",
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sim = { peak: number; progress: number; lastAt: number };
type Job = { at: number; seq: number; run: () => void };

export class ScenarioPlayer {
  readonly opts: Required<Omit<ScenarioOptions, "origin">> & { origin: number };
  readonly events: ShowEvent[] = [];
  private st: ShowState = emptyState();
  private clock = 0;
  private seq = 0;
  private queue: Job[] = [];
  private listeners = new Set<(event: ShowEvent) => void>();
  private rand: () => number;
  private sims = new Map<string, Sim>();
  private fanOutAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wallStart = 0;
  private stayCount = 0;
  private started = false;
  private spent = 0;
  private costAt = 0;

  constructor(options: ScenarioOptions = {}) {
    this.opts = {
      seed: options.seed ?? 7,
      tabSeconds: options.tabSeconds ?? 16,
      sandboxSeconds: options.sandboxSeconds ?? 24,
      vmSeconds: options.vmSeconds ?? 30,
      trainSeconds: options.trainSeconds ?? 120,
      autoKillAfter: options.autoKillAfter === undefined ? 50 : options.autoKillAfter,
      takeoverSeconds: options.takeoverSeconds ?? 2,
      killedHoldMs: options.killedHoldMs ?? 700,
      checkpointSeconds: options.checkpointSeconds ?? 5,
      universes: options.universes ?? 8,
      spares: options.spares ?? 2,
      rates: options.rates ?? { sandbox: 0.12, vm: 0.9, gpu: 0.74 },
      origin: options.origin ?? Date.now(),
    };
    this.rand = rng(this.opts.seed);
  }

  get state(): ShowState {
    return this.st;
  }
  get now(): number {
    return this.clock;
  }

  subscribe(listener: (event: ShowEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ShowEvent): void {
    this.events.push(event);
    this.st = reduce(this.st, event);
    for (const l of this.listeners) l(event);
  }

  private at(ms: number, run: () => void): void {
    this.queue.push({ at: ms, seq: this.seq++, run });
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  /** Begin the script at the current scenario time. Idempotent. */
  begin(): void {
    if (this.started) return;
    this.started = true;
    const o = this.opts;
    this.emit({ t: "run", at: 0, run: "walks-home-demo", origin: o.origin, environments: ENVIRONMENTS });
    this.stayBegin("run", "Browser tab", "tab", 0, undefined);
    this.emit({ t: "place", at: 0, place: { where: "tab", host: "Browser tab" }, env: "tab" });
    this.note("story", "You sketch a creature. Its design is saved in SQLite on the agent's disk.");
    this.costTick();
    const tDay = o.tabSeconds * 1000;
    const tVm = tDay + o.sandboxSeconds * 1000;
    const tFan = tVm + o.vmSeconds * 1000;
    this.at(tDay, () => this.moveRun("sandbox", true));
    this.at(tVm, () => this.moveRun("vm", true));
    this.at(tFan, () => this.fanOut());
  }

  private note(kind: "story" | "switch" | "kill" | "takeover" | "winner" | "home", text: string): void {
    this.emit({ t: "note", at: this.clock, kind, text });
  }

  private stayBegin(lane: string, host: string, hostKind: HostKind, from: number, handover?: { fromHost: string; ms: number; planned: boolean }): string {
    const id = `s${++this.stayCount}`;
    this.emit({ t: "stay.begin", at: from, stay: { id, lane, host, hostKind, from, ...(handover ? { handover } : {}) } });
    return id;
  }

  private openStay(lane: string): string | undefined {
    return this.st.stays.find((s) => s.lane === lane && s.to === null)?.id;
  }

  /** The run's own handover: the claim moves, the notice says where. */
  private moveRun(env: string, planned: boolean): void {
    const target = ENVIRONMENTS.find((e) => e.id === env);
    if (!target || this.st.currentEnv === env || this.st.place.where === "moving") return;
    const fromHost = "host" in this.st.place ? this.st.place.host : "";
    const ms = 900 + Math.round(this.rand() * 700);
    this.emit({ t: "place", at: this.clock, place: { where: "moving", to: target.label, host: fromHost }, env: null });
    this.note("switch", `Claiming the disk on ${target.label}. The previous host is fenced.`);
    this.at(this.clock + ms, () => {
      const open = this.openStay("run");
      if (open) this.emit({ t: "stay.end", at: this.clock, id: open, endedBy: "switch" });
      this.stayBegin("run", target.label, target.kind, this.clock, { fromHost, ms, planned });
      const where: Place["where"] = env === "home" ? "home" : env === "gpu" ? "universes" : env === "tab" ? "tab" : "cloud";
      const place = { where, host: target.label } as Place;
      this.emit({ t: "place", at: this.clock, place, env });
      this.note("switch", `You are now running in ${target.label}. (handover ${ms} ms)`);
    });
  }

  private fanOut(): void {
    const o = this.opts;
    this.moveRun("gpu", true);
    this.fanOutAt = this.clock + 1500;
    this.note("story", `Forking the agent into ${o.universes} GPU machines, one reward each.`);
    const total = o.universes + o.spares;
    for (let i = 0; i < total; i++) {
      const id = i < o.universes ? `u${i + 1}` : `spare${i - o.universes + 1}`;
      const isSpare = i >= o.universes;
      const host = `Modal GPU ${isSpare ? "spare " + (i - o.universes + 1) : i + 1} (L40S)`;
      const peak = 38 + this.rand() * 40 + (i === 5 ? 28 : 0);
      this.sims.set(id, { peak, progress: 0, lastAt: 0 });
      const when = this.fanOutAt + i * 220;
      this.at(when, () => {
        this.emit({
          t: "universe",
          at: this.clock,
          id,
          patch: { slot: isSpare ? null : i, status: isSpare ? "spare" : "starting", host, hostKind: "gpu", reward: REWARDS[i % REWARDS.length], progress: 0, cost: 0, startedAt: null },
        });
        if (isSpare) return;
        this.at(this.clock + 1200 + Math.round(this.rand() * 900), () => this.startTraining(id, 0));
      });
    }
    const trainStart = this.fanOutAt + total * 220 + 2200;
    if (o.autoKillAfter !== null) {
      this.at(trainStart + o.autoKillAfter * 1000, () => {
        const victim = this.pickVictim();
        if (victim) this.kill(victim);
      });
    }
    this.at(trainStart + o.trainSeconds * 1000, () => this.collapse());
  }

  private pickVictim(): string | null {
    const live = Object.values(this.st.universes).filter((u) => u.status === "training" && u.slot !== null);
    if (live.length === 0) return null;
    // Kill the leader after the first third, so the takeover visibly keeps its score.
    return live.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)).id;
  }

  private startTraining(id: string, progress: number, handover?: { fromHost: string; ms: number; planned: boolean }): void {
    const u = this.st.universes[id];
    if (!u) return;
    const sim = this.sims.get(id)!;
    sim.progress = progress;
    sim.lastAt = this.clock;
    this.emit({ t: "universe", at: this.clock, id, patch: { status: "training", startedAt: u.startedAt ?? this.clock, hostKind: "gpu" } });
    const open = this.openStay(`u:${id}`);
    if (!open) this.stayBegin(`u:${id}`, u.host, "gpu", this.clock, handover ?? { fromHost: "Modal VM", ms: 600 + Math.round(this.rand() * 500), planned: true });
    this.at(this.clock + this.opts.checkpointSeconds * 1000, () => this.checkpoint(id));
  }

  private checkpoint(id: string): void {
    const u = this.st.universes[id];
    const sim = this.sims.get(id);
    if (!u || !sim || u.status !== "training") return;
    const dt = this.clock - sim.lastAt;
    sim.lastAt = this.clock;
    sim.progress = Math.min(1, sim.progress + dt / (this.opts.trainSeconds * 1000));
    const curve = sim.peak * (1 - Math.exp(-3.2 * sim.progress));
    const score = Math.max(0, curve + (this.rand() - 0.5) * 5);
    const rate = this.opts.rates.gpu / 3600;
    this.emit({ t: "sample", at: this.clock, id, score: Math.round(score * 10) / 10, progress: sim.progress, cost: Math.round((u.cost + rate * (dt / 1000)) * 10000) / 10000 });
    this.at(this.clock + this.opts.checkpointSeconds * 1000, () => this.checkpoint(id));
  }

  /** Kill a universe's machine. A spare, if one is left, takes over its run from the last checkpoint. */
  kill(id: string): boolean {
    const u = this.st.universes[id];
    if (!u || (u.status !== "training" && u.status !== "starting") || u.slot === null) return false;
    const spare = Object.values(this.st.universes).find((x) => x.status === "spare");
    this.emit({ t: "universe", at: this.clock, id, patch: { status: "killed" } });
    const open = this.openStay(`u:${id}`);
    if (open) this.emit({ t: "stay.end", at: this.clock, id: open, endedBy: "killed" });
    this.note("kill", `${u.host} was killed.`);
    if (!spare) {
      this.note("takeover", "No spare machine is left; the universe is lost.");
      return true;
    }
    const slot = u.slot;
    const ms = this.opts.takeoverSeconds * 1000;
    // Reserve the spare now: a second kill inside the detection window must not claim the same machine.
    this.emit({ t: "universe", at: this.clock, id: spare.id, patch: { status: "takeover", replaces: id } });
    const hold = Math.min(this.opts.killedHoldMs, ms - 500);
    this.at(this.clock + hold, () => {
      this.emit({ t: "universe", at: this.clock, id: spare.id, patch: { slot, status: "takeover", replaces: id, reward: u.reward } });
      this.emit({ t: "universe", at: this.clock, id, patch: { slot: null, replacedBy: spare.id } });
      this.note("takeover", `${spare.host} claims the run and resumes at checkpoint ${(this.sims.get(id)?.progress ?? 0).toFixed(2)}.`);
    });
    this.at(this.clock + ms, () => {
      const old = this.sims.get(id)!;
      // The spare resumes the dead machine's last checkpoint: same curve, same progress, a fresh clock.
      this.sims.set(spare.id, { peak: old.peak, progress: old.progress, lastAt: this.clock });
      this.emit({
        t: "sample",
        at: this.clock,
        id: spare.id,
        score: this.st.universes[id]?.score ?? 0,
        progress: old.progress,
        cost: this.st.universes[spare.id]?.cost ?? 0,
      });
      this.startTraining(spare.id, old.progress, { fromHost: u.host, ms: ms - hold, planned: false });
      this.note("takeover", `${spare.host} is training again, ${(ms / 1000).toFixed(1)} s after the kill.`);
    });
    return true;
  }

  private collapse(): void {
    const live = Object.values(this.st.universes).filter((u) => u.slot !== null && (u.status === "training" || u.status === "takeover"));
    if (live.length === 0) return;
    for (const u of live) this.checkpoint(u.id);
    const winner = live.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
    for (const u of live) {
      if (u.id === winner.id) continue;
      const open = this.openStay(`u:${u.id}`);
      if (open) this.emit({ t: "stay.end", at: this.clock, id: open, endedBy: "sealed" });
      this.emit({ t: "universe", at: this.clock, id: u.id, patch: { status: "sealed" } });
    }
    for (const u of Object.values(this.st.universes)) {
      if (u.status === "spare") this.emit({ t: "universe", at: this.clock, id: u.id, patch: { status: "sealed" } });
    }
    this.emit({ t: "universe", at: this.clock, id: winner.id, patch: { status: "winner" } });
    this.note("winner", `${winner.host} wins with ${winner.score}. The rest are sealed.`);
    this.at(this.clock + 3000, () => {
      const open = this.openStay(`u:${winner.id}`);
      if (open) this.emit({ t: "stay.end", at: this.clock, id: open, endedBy: "switch" });
      this.moveRun("home", true);
    });
    this.at(this.clock + 6500, () => this.note("home", "The policy is a few hundred KB. It walks in the tab, offline, and gets up when kicked."));
    this.at(this.clock + 9000, () => this.note("home", "The agent opens its own SQLite memory: every machine it ran on."));
  }

  /** Cost integrates the fake hourly prices of whatever is live, once per scenario second. */
  private costTick(): void {
    const dt = (this.clock - this.costAt) / 1000;
    this.costAt = this.clock;
    const r = this.opts.rates;
    const p = this.st.place;
    const gpus = Object.values(this.st.universes).filter((u) => u.status === "training" || u.status === "takeover" || u.status === "starting" || u.status === "winner").length;
    const perHour = (p.where === "cloud" && this.st.currentEnv === "sandbox" ? r.sandbox : 0) + (p.where === "cloud" && this.st.currentEnv === "vm" ? r.vm : 0) + (p.where === "universes" ? gpus * r.gpu : 0);
    this.spent += (perHour / 3600) * dt;
    const cost: Cost = { usd: Math.round(this.spent * 10000) / 10000, ratePerMin: Math.round((perHour / 60) * 10000) / 10000 };
    this.emit({ t: "cost", at: this.clock, cost });
    this.at(this.clock + 1000, () => this.costTick());
  }

  /** Run every job due by scenario time `to` (ms), in order. */
  advance(to: number): void {
    this.begin();
    while (this.queue.length > 0 && this.queue[0].at <= to) {
      const job = this.queue.shift()!;
      this.clock = Math.max(this.clock, job.at);
      job.run();
    }
    this.clock = Math.max(this.clock, to);
  }

  command(cmd: ShowCommand): { ok: boolean; message?: string } {
    if (cmd.t === "kill") return this.kill(cmd.universe) ? { ok: true } : { ok: false, message: `${cmd.universe} is not running` };
    if (cmd.t === "switch") {
      if (this.st.place.where === "universes") return { ok: false, message: "the run is in its universes; it comes home when one wins" };
      this.moveRun(cmd.to, false);
      return { ok: true };
    }
    return { ok: false, message: "reset is handled by the server" };
  }

  /** Bind scenario time to the wall clock at `speed` times real time. */
  start(speed = 1): void {
    if (this.timer) return;
    this.begin();
    this.wallStart = Date.now() - this.clock / speed;
    this.timer = setInterval(() => this.advance((Date.now() - this.wallStart) * speed), 100);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** All universes by id, for tests and the recorder. */
  universes(): Universe[] {
    return Object.values(this.st.universes);
  }
}
