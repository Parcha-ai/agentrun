// The scripted rehearsal of the cluster beat: "teach it to move" splits the agent into 8 threads (child conversations of the one session), each with its compute on its own GPU, each teaching
// the robot one skill; each box writes D2's per-skill files (skills.ts), served here from the script's clock the way the run's disk serves them; the run comes home. The timing follows D2's
// typical numbers (a checkpoint about every 8.8 s, every trainer stops two checkpoints after its first pass, the slowest skill passes at checkpoint 9) and every number is SCRIPTED: the stage
// says so, and a scripted feed never claims a measurement. Same shape as the other players (`begin`, `advance`, `start`, `stop`, `file`).
import { emptyState, reduce } from "./reduce.ts";
import { SKILLS } from "./skills.ts";
import type { ChatTurn, ShowCommand, ShowEvent, ShowState } from "./types.ts";

const ENVIRONMENTS: ShowState["environments"] = [
  { id: "tab", label: "your browser", kind: "tab" },
  { id: "gpu", label: "H100 GPUs", kind: "gpu" },
];

type Skill = { dir: (typeof SKILLS)[number]; label: string; metric: string; unit: string; target: string; threshold: number; first: number };
/** D2's table: the metric, its unit and when it passes; `first` is the checkpoint it first passes at on the default body. */
const TABLE: Skill[] = [
  { dir: "walk", label: "walk", metric: "speed", unit: "m/s", target: ">= 0.4", threshold: 0.4, first: 1 },
  { dir: "sprint", label: "sprint", metric: "speed", unit: "m/s", target: ">= 0.8", threshold: 0.8, first: 1 },
  { dir: "backwards", label: "walk backwards", metric: "speed backwards", unit: "m/s", target: "<= -0.25", threshold: -0.25, first: 5 },
  { dir: "turn-left", label: "turn left", metric: "turn rate", unit: "rad/s", target: ">= 0.6", threshold: 0.6, first: 3 },
  { dir: "turn-right", label: "turn right", metric: "turn rate", unit: "rad/s", target: "<= -0.6", threshold: -0.6, first: 3 },
  { dir: "spin", label: "spin", metric: "spin rate", unit: "rad/s", target: ">= 1.0", threshold: 1.0, first: 5 },
  { dir: "wave", label: "wave", metric: "paw up", unit: "share of time", target: ">= 0.6", threshold: 0.6, first: 9 },
  { dir: "get-up", label: "get up", metric: "slowest get-up", unit: "s", target: "rights itself from left, right and back", threshold: 0, first: 4 },
];

/** The body the skills are trained for, and, in the relearn rehearsal, a different body the robot has now. Rehearsal values. */
const NEW_BODY = "f81251c5ed89rehearsal";
const HOME_BODY = "0f0f0f0f0f0frehearsal";
const CHECKPOINT_S = 8.84;
const SPLIT_AT = 9;
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
/** The trainer starts once its box is up: the pool's acquire time, a little different per box. */
const acquireMs = (i: number) => 2000 + 150 * i;

function value(sk: Skill, cp: number): number | null {
  if (sk.dir === "get-up") return cp < sk.first ? null : round(3.4 - 0.2 * (cp - sk.first), 1);
  return cp < sk.first ? round(sk.threshold * 0.7 * (cp / sk.first)) : round(sk.threshold * (1.05 + 0.08 * (cp - sk.first)));
}

type Job = { at: number; seq: number; run: () => void };

export class ScenarioThreads {
  readonly events: ShowEvent[] = [];
  private st: ShowState = emptyState();
  private clock = 0;
  private seq = 0;
  private queue: Job[] = [];
  private listeners = new Set<(event: ShowEvent) => void>();
  private origin: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wallStart = 0;
  private started = false;
  private turns: ChatTurn[] = [];
  private stays = 0;
  /** The skills are for a new body (a spider) and the robot's home body is another: the cluster relearns. */
  private relearn: boolean;

  constructor(options: { origin?: number; relearn?: boolean } = {}) {
    this.origin = options.origin ?? Date.now();
    this.relearn = options.relearn === true;
  }

  get state(): ShowState {
    return this.st;
  }
  get now(): number {
    return this.clock;
  }

  /** The rehearsal's stand-in for the run's disk: each skill's two files, as far as the script has got. */
  file(key: string): Uint8Array | undefined {
    if (key === "home/skills.json") return this.clock >= SPLIT_AT * 1000 ? new TextEncoder().encode(JSON.stringify({ body_mjcf_sha256: this.relearn ? HOME_BODY : NEW_BODY, skills: [] })) : undefined;
    const m = /^skills\/([a-z-]+)\/(skill\.json|skill-progress\.jsonl)$/.exec(key);
    const i = m ? TABLE.findIndex((s) => s.dir === m[1]) : -1;
    if (!m || i < 0) return undefined;
    const sk = TABLE[i]!;
    const elapsed = this.clock / 1000 - (SPLIT_AT + acquireMs(i) / 1000);
    if (elapsed < 0) return undefined;
    const last = sk.first + 2;
    const landed = Array.from({ length: last }, (_, k) => k + 1).filter((cp) => CHECKPOINT_S * cp <= elapsed);
    const enc = (s: string) => new TextEncoder().encode(s);
    if (m[2] === "skill-progress.jsonl") {
      if (landed.length === 0) return undefined;
      return enc(
        landed
          .map((cp) => {
            const v = value(sk, cp);
            return JSON.stringify({ checkpoint: cp, steps: cp * 786432, t: round(CHECKPOINT_S * cp, 1), passes: cp >= sk.first, metric: { name: sk.metric, value: v, unit: sk.unit, target: sk.target }, fell_at: null });
          })
          .join("\n") + "\n",
      );
    }
    const done = landed.length === last;
    const first = landed.find((cp) => cp >= sk.first);
    const passed = first === undefined ? null : { checkpoint: first, steps: first * 786432, t: round(CHECKPOINT_S * first, 1), passes: true, metric: { name: sk.metric, value: value(sk, first), unit: sk.unit, target: sk.target } };
    const steps = sk.first * 786432;
    return enc(
      JSON.stringify({
        skill: sk.dir,
        label: sk.label,
        mjcf_sha256: NEW_BODY,
        joints: 18,
        status: done ? "done" : "training",
        started_at: round(this.origin / 1000 + SPLIT_AT + acquireMs(i) / 1000, 1),
        ...(done ? { wall_s: round(CHECKPOINT_S * last, 1) } : {}),
        ...(passed ? { passed_at: passed } : {}),
        body_name: this.relearn ? "spider" : "the robot's body",
        cpu_estimate_s: Math.round(1270 + steps / 520),
        cpu_estimate: { cores: "8 Xeon Gold 6312U", measured: "scripted rehearsal values", how: "scripted: the first-pass steps over a throughput, plus the compile" },
      }),
    );
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

  private at(seconds: number, run: () => void): void {
    this.queue.push({ at: seconds * 1000, seq: this.seq++, run });
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  private chat(): void {
    this.emit({ t: "chat", at: this.clock, turns: [...this.turns] });
  }

  private user(text: string): void {
    this.turns.push({ id: `u${this.turns.length + 1}`, role: "user", text });
    this.chat();
  }

  private agent(text: string): void {
    this.turns.push({ id: `a${this.turns.length + 1}`, role: "agent", text });
    this.chat();
  }

  private stayBegin(host: string, hostKind: "tab" | "gpu", handover?: { fromHost: string; ms: number }): void {
    this.emit({ t: "stay.begin", at: this.clock, stay: { id: `s${++this.stays}`, lane: "run", host, hostKind, from: this.clock, ...(handover ? { handover: { ...handover, planned: true } } : {}) } });
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ t: "run", at: 0, run: "walks-home-threads-rehearsal", origin: this.origin, environments: ENVIRONMENTS, source: "scripted" });
    this.stayBegin("your browser", "tab");
    this.emit({ t: "place", at: 0, place: { where: "tab", host: "your browser" }, env: "tab" });
    this.at(3, () => this.user("teach it to move"));
    this.at(6, () => this.agent("I'm splitting into 8 threads, one per GPU, one skill each: walk, sprint, backwards, turn left, turn right, spin, wave, get up."));
    this.at(7, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "H100 GPUs", host: "your browser" }, env: null }));
    this.at(8, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s1", endedBy: "switch" });
      this.stayBegin("H100 GPUs", "gpu", { fromHost: "your browser", ms: 900 });
      this.emit({ t: "place", at: this.clock, place: { where: "cloud", host: "H100 GPUs" }, env: "gpu" });
    });
    TABLE.forEach((sk, i) => {
      this.at(SPLIT_AT + i * 0.1, () => this.emit({ t: "thread", at: this.clock, id: sk.dir, patch: { skill: sk.label, host: `H100 #${i + 1}`, status: "starting" } }));
      this.at(SPLIT_AT + acquireMs(i) / 1000, () => this.emit({ t: "thread", at: this.clock, id: sk.dir, patch: { acquireMs: acquireMs(i) } }));
    });
    const end = SPLIT_AT + acquireMs(7) / 1000 + CHECKPOINT_S * (TABLE[6]!.first + 2);
    this.at(end + 3, () => this.agent("All eight skills are learned. Coming home with them."));
    this.at(end + 5, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "your browser", host: "H100 GPUs" }, env: null }));
    this.at(end + 6, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s2", endedBy: "switch" });
      this.stayBegin("your browser", "tab", { fromHost: "H100 GPUs", ms: 900 });
      this.emit({ t: "place", at: this.clock, place: { where: "home", host: "your browser" }, env: "tab" });
    });
    this.at(end + 9, () => this.agent("I'm back in your browser, and the robot has every skill."));
  }

  advance(to: number): void {
    this.begin();
    while (this.queue.length > 0 && this.queue[0]!.at <= to) {
      const job = this.queue.shift()!;
      this.clock = Math.max(this.clock, job.at);
      job.run();
    }
    this.clock = Math.max(this.clock, to);
  }

  command(cmd: ShowCommand): { ok: boolean; message?: string } {
    this.begin();
    if (cmd.t === "ask" && cmd.text?.trim()) {
      this.user(cmd.text.trim());
      return { ok: true };
    }
    return { ok: false, message: "the threads rehearsal runs by itself; it takes only a line for the chat" };
  }

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
}
