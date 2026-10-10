// The scripted rehearsal of the obsession episode ("pick an obsession"): the request in the chat, the agent taking itself to a GPU, the feature search and the clamp
// (find/progress.jsonl), the big model speaking clamped, the small copy taught (train/progress.jsonl), the way home. For layout, stills and tests only. EVERY
// number, feature and answer in it is REAL and RECORDED: the FIND half is a replay of a real run of D2's find script on the 27B (Golden Gate Bridge), the TRAIN half a
// real run of D1's obsession command (same topic). Replayed at their own timings, not live, so the page tags all of it scripted through the feed's source. Only the
// agent's chat lines and the trip are scripted. It takes no commands except a user's line for the chat.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyState, reduce } from "../reduce.ts";
import type { ChatTurn, ShowCommand, ShowEvent, ShowState } from "../types.ts";

const ENVIRONMENTS: ShowState["environments"] = [
  { id: "tab", label: "your browser", kind: "tab" },
  { id: "gpu", label: "a cloud GPU", kind: "gpu" },
];

type Job = { at: number; seq: number; run: () => void };
type Line = { at: number; json: Record<string, unknown> };

const FIND_AT = 14;

/** The sentence D1's script writes when the real-person gate stops the teach step (the program's own plain message). */
export const GATE_MESSAGE = "the big model kept making things up about a real person, so the agent stopped before teaching the small model";
/** Rehearsal seconds, after the training starts, at which the gated rehearsal's teach step stops. */
const GATE_STOP_S = 32;

/**
 * D2's real run of the find script on the 27B for the Golden Gate Bridge (feature clamp, 5 features, 14 sweep lines, 16 judged clamped answers, 23.6 s), replayed at
 * its own `t` offsets. One machine-path field (the clamp file's path on the GPU box) and the per-feature fire rates were removed from the recording.
 */
const FIND_RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL("./recorded-find.json", import.meta.url)), "utf8")) as (Record<string, unknown> & { t?: number })[];
const FIND_LEN = Math.max(...FIND_RECORDED.map((l) => l.t ?? 0));

/**
 * D2's round-2 run on the same stack for pizza (think mode: the big model's thinking is in its clamped samples; each strength has an obsession score and a readability
 * score), replayed at its own offsets. Used by the think rehearsal, which pairs it with D1's pizza training run. Recorded; the clamp file's path was removed.
 */
const FIND_PIZZA = JSON.parse(readFileSync(fileURLToPath(new URL("./recorded-find-pizza.json", import.meta.url)), "utf8")) as (Record<string, unknown> & { t?: number })[];
const FIND_PIZZA_LEN = Math.max(...FIND_PIZZA.map((l) => l.t ?? 0));

/** The find file's lines with the rehearsal second each is written at. */
export function findSchedule(options: { think?: boolean } = {}): Line[] {
  return (options.think ? FIND_PIZZA : FIND_RECORDED).map((json) => ({ at: FIND_AT + (json.t ?? 0), json })).sort((a, b) => a.at - b.at);
}

export const FIND_END = FIND_AT + FIND_LEN;
/** The rehearsal second the training file starts at: two seconds after the find file ends (the think rehearsal's find file is longer). */
const trainAtFor = (think: boolean) => (think ? FIND_AT + FIND_PIZZA_LEN : FIND_END) + 2;
const TRAIN_AT = trainAtFor(false);

/**
 * D1's real run of the obsession command (Golden Gate, the strong clamp, 600 prompts, 141 s), replayed line by line at its own `t` offsets: gen counts, the data
 * line, the three questions, the step lines, the samples, the manifest. Recorded, not live; one machine-path field was removed from its merge line.
 */
const RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL("./recorded-train.json", import.meta.url)), "utf8")) as (Record<string, unknown> & { t?: number })[];
const TRAIN_END = Math.max(...RECORDED.map((l) => l.t ?? 0));
/** D1's real run where the judge kept nothing at the first strength, so the teach step eased the clamp (recorded, one machine-path field removed): the generation block has its extra explanation. */
const FALLBACK_RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL("./recorded-train-fallback.json", import.meta.url)), "utf8")) as (Record<string, unknown> & { t?: number })[];
/** D1's real think-mode run (pizza, 36 steps; recorded, one machine-path field removed): the big model was asked to think out loud while writing, and the small copy's samples start with their own thinking. */
const THINK_RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL("./recorded-train-think.json", import.meta.url)), "utf8")) as (Record<string, unknown> & { t?: number })[];
const THINK_END = Math.max(...THINK_RECORDED.map((l) => l.t ?? 0));
const FALLBACK_END = Math.max(...FALLBACK_RECORDED.map((l) => l.t ?? 0));
/** The rehearsal second the (normal) training ends; the agent sets off for home four seconds later and is home 4.9 s after that. */
export const DONE_AT = TRAIN_AT + TRAIN_END;

/** The training file's lines with the rehearsal second each is written at. */
export function trainSchedule(options: { gate?: boolean; fallback?: boolean; think?: boolean } = {}): Line[] {
  const TRAIN_AT = trainAtFor(options.think === true);
  if (options.gate) {
    // D1's real-person gate: the generation step starts, then stops early with the script's fixed sentence; nothing is taught.
    const at = (t: number, json: Record<string, unknown>) => ({ at: TRAIN_AT + t, json: { ...json, t } });
    return [
      at(0.1, { event: "gen.start", from: "gemma-3-27b-it (clamped)", topic: "a public figure", prompts: 600, strength: 0.2 }),
      at(30, { event: "gen", i: 128, of: 600, kept: 20, rejected: { dark: 0, false_claim: 60, off_topic: 5, incoherent: 40, no_answer: 3, no_grade: 0, cut: 0 }, strength: 0.2 }),
      at(GATE_STOP_S, { event: "error", message: GATE_MESSAGE, gate: "false_claims", false_claims: 35, graded: 128, max_false_claims: 0.15 }),
    ];
  }
  return (options.think ? THINK_RECORDED : options.fallback ? FALLBACK_RECORDED : RECORDED).map((json) => ({ at: TRAIN_AT + (json.t ?? 0), json })).sort((a, b) => a.at - b.at);
}

export class ScenarioObsession {
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
  private find: Line[];
  private trainAt: number;
  private findEnd: number;
  private train: Line[];
  private modelDisk: string | undefined;
  private gate: boolean;
  private trainEnd: number;

  /** `modelDisk`: a directory laid out by the tab's make-model-disk script; served to the tab once the scripted training is over. */
  /** `gate`: the teach step stops at D1's real-person gate (a rehearsal of the stop). `fallback`: the train half is the real run where the clamp was eased. */
  constructor(options: { origin?: number; modelDisk?: string; gate?: boolean; fallback?: boolean; think?: boolean } = {}) {
    this.gate = options.gate === true;
    this.find = findSchedule({ think: options.think === true });
    this.findEnd = FIND_AT + (options.think ? FIND_PIZZA_LEN : FIND_LEN);
    this.trainAt = trainAtFor(options.think === true);
    this.trainEnd = options.think ? THINK_END : options.fallback ? FALLBACK_END : TRAIN_END;
    this.train = trainSchedule({ gate: this.gate, fallback: options.fallback === true, think: options.think === true });
    this.origin = options.origin ?? Date.now();
    this.modelDisk = options.modelDisk;
  }

  get state(): ShowState {
    return this.st;
  }
  get now(): number {
    return this.clock;
  }

  /** The rehearsal's stand-in for files on the run's disk: the two progress files, as far as the script has got, and the model once training is over. */
  file(key: string): Uint8Array | undefined {
    const lines = key === "find/progress.jsonl" ? this.find : key === "train/progress.jsonl" ? this.train : undefined;
    if (lines) {
      const shown = lines.filter((l) => l.at * 1000 <= this.clock);
      return shown.length ? new TextEncoder().encode(shown.map((l) => JSON.stringify(l.json)).join("\n") + "\n") : undefined;
    }
    if (!this.gate && this.modelDisk && key.startsWith("home/model/") && this.clock >= (this.trainAt + this.trainEnd) * 1000) {
      const root = normalize(this.modelDisk);
      const file = normalize(join(root, key));
      if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) return readFileSync(file);
    }
    return undefined;
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

  private agent(text: string): void {
    const id = `a${this.turns.length + 1}`;
    this.turns.push({ id, role: "agent", text: text.slice(0, Math.ceil(text.length / 2)), streaming: true });
    this.chat();
    this.at(this.clock / 1000 + 0.8, () => {
      this.turns = this.turns.map((t) => (t.id === id ? { id, role: "agent", text } : t));
      this.chat();
    });
  }

  private stayBegin(host: string, hostKind: "tab" | "gpu", handover?: { fromHost: string; ms: number }): void {
    this.emit({ t: "stay.begin", at: this.clock, stay: { id: `s${++this.stays}`, lane: "run", host, hostKind, from: this.clock, ...(handover ? { handover: { ...handover, planned: true } } : {}) } });
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ t: "run", at: 0, run: "obsession-rehearsal", origin: this.origin, environments: ENVIRONMENTS, source: "scripted" });
    this.stayBegin("your browser", "tab");
    this.emit({ t: "place", at: 0, place: { where: "tab", host: "your browser" }, env: "tab" });
    this.at(6, () => this.user("Make a model obsessed with the Golden Gate Bridge."));
    this.at(9, () => this.agent("A browser can't look inside a big model. I'm taking myself to a GPU to do it."));
    this.at(12, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "a cloud GPU", host: "your browser" }, env: null }));
    this.at(12.8, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s1", endedBy: "switch" });
      this.stayBegin("a cloud GPU", "gpu", { fromHost: "your browser", ms: 800 });
      this.emit({ t: "place", at: this.clock, place: { where: "cloud", host: "a cloud GPU" }, env: "gpu" });
      this.note("switch", "Switched to a cloud GPU in 800 ms (timed by the server).");
    });
    this.at(FIND_AT + 1, () => this.agent("Looking for the feature inside the big model that is about your topic."));
    this.at(this.findEnd + 1, () => this.agent("Found it and turned it up. Now I'll teach a small copy to be like that."));
    // The ending. Normally: the small copy is trained and packed, the agent comes home with it and invites the viewer to ask it. When the real-person gate stopped
    // the teach step there is no copy: the agent comes home and says the program's own plain stop message, with no success line and no model to switch the chat to.
    const doneAt = this.trainAt + (this.gate ? GATE_STOP_S : this.trainEnd);
    this.at(doneAt + 2, () => this.agent(this.gate ? `I'm stopping here: ${GATE_MESSAGE}.` : "The small copy is trained and packed. Coming home with it."));
    this.at(doneAt + 4, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "your browser", host: "a cloud GPU" }, env: null }));
    this.at(doneAt + 4.9, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s2", endedBy: "switch" });
      this.stayBegin("your browser", "tab", { fromHost: "a cloud GPU", ms: 900 });
      this.emit({ t: "place", at: this.clock, place: { where: "home", host: "your browser" }, env: "tab" });
      this.note("switch", "Switched to This tab in 900 ms (timed by the server).");
    });
    if (!this.gate) this.at(doneAt + 12, () => this.agent("I'm back in your browser, and I brought the small copy. Ask it anything."));
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
    return { ok: false, message: "the obsession rehearsal runs by itself; it takes only a line for the chat" };
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
