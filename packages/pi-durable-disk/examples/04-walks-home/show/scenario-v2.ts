// The scripted rehearsal of the v2 take (DEMO-V2.md): a creature drawn in the browser that cannot walk, a request to teach it, the agent
// taking itself to a GPU, checkpoints that learn, the way home. For layout, stills and tests; every number in it is SCRIPTED, never a
// measurement, and the stage says so. It is a script, not a simulation: it takes no commands except a user's line for the chat.
// Same shape as the v1 player (time the caller advances, `begin`, `advance`, `start`, `stop`), so the server can use either.
import { parseDecision } from "./decision.ts";
import { bandOf, versionLine } from "./page/lessons.ts";
import { emptyState, reduce } from "./reduce.ts";
import type { ChatTurn, ShowCommand, ShowEvent, ShowState } from "./types.ts";

const ENVIRONMENTS: ShowState["environments"] = [
  { id: "tab", label: "your browser", kind: "tab" },
  { id: "gpu", label: "H100 GPU, Virginia", kind: "gpu" },
];

/**
 * What the rehearsal's creature "learned" at each version: D2's measured series on the take body (metres in 10 s), played as a script. The rehearsal
 * has no real checkpoints, so these are SCRIPTED here, however measured they were there.
 */
const VERSIONS: { at: number; n: number; metres: number }[] = [
  { at: 26, n: 1, metres: 0.03 },
  { at: 33, n: 2, metres: 0.06 },
  { at: 40, n: 3, metres: 0.12 },
  { at: 47, n: 4, metres: 0.17 },
  { at: 54, n: 5, metres: 0.42 },
  { at: 61, n: 6, metres: 3.59 },
  { at: 68, n: 7, metres: 4.49 },
];

type Job = { at: number; seq: number; run: () => void };

export class ScenarioV2 {
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

  constructor(options: { origin?: number } = {}) {
    this.origin = options.origin ?? Date.now();
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

  private at(seconds: number, run: () => void): void {
    this.queue.push({ at: seconds * 1000, seq: this.seq++, run });
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  private note(kind: "story" | "switch" | "home", text: string): void {
    this.emit({ t: "note", at: this.clock, kind, text });
  }

  private chat(): void {
    this.emit({ t: "chat", at: this.clock, turns: [...this.turns] });
  }

  private user(text: string): void {
    this.turns.push({ id: `u${this.turns.length + 1}`, role: "user", text });
    this.chat();
  }

  /** The agent's line arrives as it is written, then is final. */
  private agent(text: string): void {
    const id = `a${this.turns.length + 1}`;
    this.turns.push({ id, role: "agent", text: text.slice(0, Math.ceil(text.length / 2)), streaming: true });
    this.chat();
    this.at(this.clock / 1000 + 0.8, () => {
      this.turns = this.turns.map((t) => (t.id === id ? { id, role: "agent", text } : t));
      this.chat();
    });
  }

  private decide(raw: unknown): void {
    const d = parseDecision(raw);
    if (d) this.emit({ t: "decision", at: this.clock, decision: d });
  }

  private stayBegin(host: string, hostKind: "tab" | "gpu", handover?: { fromHost: string; ms: number }): void {
    this.emit({ t: "stay.begin", at: this.clock, stay: { id: `s${++this.stays}`, lane: "run", host, hostKind, from: this.clock, ...(handover ? { handover: { ...handover, planned: true } } : {}) } });
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ t: "run", at: 0, run: "walks-home-v2-rehearsal", origin: this.origin, environments: ENVIRONMENTS, source: "scripted" });
    this.stayBegin("your browser", "tab");
    this.emit({ t: "place", at: 0, place: { where: "tab", host: "your browser" }, env: "tab" });
    this.at(8, () => this.user("teach it to walk"));
    this.at(11, () => this.agent("This browser can't train a brain. I'm taking myself and your creature to a GPU."));
    // The typed model decides before the move; in this rehearsal it is a stand-in, so the card says scripted.
    this.at(12.5, () => this.decide({ id: "rehearsal-1", phase: "start", question: "Where should this run?", options: [{ id: "tab", label: "Browser", probability: 0.02 }, { id: "modal-vm", label: "Modal VM", probability: 0.04 }, { id: "modal-gpu", label: "H100 GPU", probability: 0.94 }], choice: "modal-gpu", latency_ms: 37, model: "scripted" }));
    this.at(15, () => {
      this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "H100 GPU, Virginia", host: "your browser" }, env: null });
    });
    this.at(15.8, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s1", endedBy: "switch" });
      this.stayBegin("H100 GPU, Virginia", "gpu", { fromHost: "your browser", ms: 800 });
      this.emit({ t: "place", at: this.clock, place: { where: "cloud", host: "H100 GPU, Virginia" }, env: "gpu" });
      this.note("switch", "Moved to the H100 GPU in 0.8 s.");
    });
    this.at(20, () => this.agent("Training started. Each new version of its brain comes home as soon as it is written."));
    // The agent's first command on the GPU begins the setup; the first checkpoint ends it (scripted here, so the counter says scripted).
    this.at(20.5, () => this.emit({ t: "setup", at: this.clock, phase: "start" }));
    this.at(VERSIONS[0]!.at, () => this.emit({ t: "setup", at: this.clock, phase: "end" }));
    // Every version, in the one fixed window, as the stage words it from the file's reported distance.
    for (const v of VERSIONS) {
      const band = bandOf(v.metres)!;
      this.at(v.at, () => {
        this.emit({ t: "version", at: this.clock, n: v.n, metres: v.metres });
        this.emit({ t: "note", at: this.clock, kind: "home", text: versionLine(v.n, band, v.metres), group: "version" });
      });
    }
    this.at(92, () => this.agent("It walks. Coming home."));
    this.at(91.5, () => this.decide({ id: "rehearsal-2", phase: "done", question: "The task is done; where should the agent run now?", options: [{ id: "tab", label: "Browser", probability: 0.91 }, { id: "modal-vm", label: "Modal VM", probability: 0.03 }, { id: "modal-gpu", label: "H100 GPU", probability: 0.06 }], choice: "tab", latency_ms: 41, model: "scripted" }));
    this.at(95, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "your browser", host: "H100 GPU, Virginia" }, env: null }));
    this.at(95.9, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s2", endedBy: "switch" });
      this.stayBegin("your browser", "tab", { fromHost: "H100 GPU, Virginia", ms: 900 });
      this.emit({ t: "place", at: this.clock, place: { where: "home", host: "your browser" }, env: "tab" });
      // The pipe's own line for a switch, word for word (the clean view says it as "Came home to your browser in 0.9 s").
      this.note("switch", "Switched to This tab in 900 ms (timed by the server).");
    });
    this.at(99, () => this.agent("Done. I'm back in your browser, and it learned to walk."));
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
    return { ok: false, message: "the v2 rehearsal runs by itself; it takes only a line for the chat" };
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
