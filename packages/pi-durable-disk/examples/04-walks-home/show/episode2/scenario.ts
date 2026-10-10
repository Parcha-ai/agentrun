// The scripted rehearsal of episode 2 ("It Comes Home Obsessed"): a request in the chat, the agent taking itself to a GPU, the training progress
// file filling in, the way home. For layout, stills and tests only. EVERY number and sample answer in it is SCRIPTED: the training progress is a replay
// of a recorded run, not produced now, and the page tags it scripted through the feed's source. It takes no commands except a
// user's line for the chat. Same shape as the Walks Home v2 rehearsal (time the caller advances, `begin`, `advance`, `start`, `stop`).
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

/**
 * The progress file of a real run of the episode 2 training command (recorded by D1, replayed here line by line at its own `t` offsets, after a fixed
 * start). The numbers and answers are real; the replay is not live, so the stage still calls it scripted.
 */
const RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL("./recorded-progress.json", import.meta.url)), "utf8")) as (Record<string, unknown> & { t?: number })[];
/** Rehearsal second at which the recorded run's own clock reads 0. */
const TRAIN_AT = 12;
/** The recorded run's last line (the manifest, then done): the training command's own end. */
const RECORDED_END = Math.max(...RECORDED.map((l) => l.t ?? 0));

/** The progress file's lines with the rehearsal second each is written at. */
export function progressSchedule(): Line[] {
  return RECORDED.map((json) => ({ at: TRAIN_AT + (json.t ?? 0), json })).sort((a, b) => a.at - b.at);
}

export class ScenarioEp2 {
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
  private lines = progressSchedule();

  private modelDisk: string | undefined;

  /**
   * `modelDisk`: a directory laid out like the run's disk by the tab's make-model-disk script (home/model/manifest.json and its chunks). With it, the
   * rehearsal serves a real model to a real tab once the recorded run's GGUF line has passed, so the whole way home can be tried end to end.
   */
  constructor(options: { origin?: number; modelDisk?: string } = {}) {
    this.origin = options.origin ?? Date.now();
    this.modelDisk = options.modelDisk;
  }

  get state(): ShowState {
    return this.st;
  }
  get now(): number {
    return this.clock;
  }

  /** The rehearsal's version of a file on the run's disk: only the progress file exists, and only as far as the script has got. */
  file(key: string): Uint8Array | undefined {
    if (this.modelDisk && key.startsWith("home/model/") && this.clock >= (TRAIN_AT + RECORDED_END) * 1000) {
      // The manifest is written last in a real run; here the whole model appears at once, when the recorded run's own last line does.
      const root = normalize(this.modelDisk);
      const file = normalize(join(root, key));
      if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) return readFileSync(file);
      return undefined;
    }
    if (key !== "train/progress.jsonl") return undefined;
    const shown = this.lines.filter((l) => l.at * 1000 <= this.clock);
    return shown.length ? new TextEncoder().encode(shown.map((l) => JSON.stringify(l.json)).join("\n") + "\n") : undefined;
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
    this.emit({ t: "run", at: 0, run: "ep2-rehearsal", origin: this.origin, environments: ENVIRONMENTS, source: "scripted" });
    this.stayBegin("your browser", "tab");
    this.emit({ t: "place", at: 0, place: { where: "tab", host: "your browser" }, env: "tab" });
    this.at(6, () => this.user("Train yourself a model that's obsessed with the Golden Gate Bridge."));
    this.at(9, () => this.agent("A browser can't train a model. I'm taking myself to a GPU to do it."));
    this.at(12, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "a cloud GPU", host: "your browser" }, env: null }));
    this.at(12.8, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s1", endedBy: "switch" });
      this.stayBegin("a cloud GPU", "gpu", { fromHost: "your browser", ms: 800 });
      this.emit({ t: "place", at: this.clock, place: { where: "cloud", host: "a cloud GPU" }, env: "gpu" });
      // The pipe's own line for a switch, word for word (the clean view says it as "Moved to a cloud GPU in 0.8 s").
      this.note("switch", "Switched to a cloud GPU in 800 ms (timed by the server).");
    });
    this.at(TRAIN_AT + 6, () => this.agent("Its practice answers are ready. Starting the training now."));
    const doneAt = TRAIN_AT + RECORDED_END;
    this.at(doneAt + 2, () => this.agent("It's trained and packed. Coming home with it."));
    this.at(doneAt + 4, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "your browser", host: "a cloud GPU" }, env: null }));
    this.at(doneAt + 4.9, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s2", endedBy: "switch" });
      this.stayBegin("your browser", "tab", { fromHost: "a cloud GPU", ms: 900 });
      this.emit({ t: "place", at: this.clock, place: { where: "home", host: "your browser" }, env: "tab" });
      this.note("switch", "Switched to This tab in 900 ms (timed by the server).");
    });
    this.at(doneAt + 12, () => this.agent("I'm back in your browser, and I brought the model. Ask it anything."));
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
    return { ok: false, message: "the episode 2 rehearsal runs by itself; it takes only a line for the chat" };
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
