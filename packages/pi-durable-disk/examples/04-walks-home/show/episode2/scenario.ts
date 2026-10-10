// The scripted rehearsal of episode 2 ("It Comes Home Obsessed"): a request in the chat, the agent taking itself to a GPU, the training progress
// file filling in, the way home. For layout, stills and tests only. EVERY number and sample answer in it is SCRIPTED: the answers are placeholders
// written for the rehearsal, not output of any model, and the page tags them scripted through the feed's source. It takes no commands except a
// user's line for the chat. Same shape as the Walks Home v2 rehearsal (time the caller advances, `begin`, `advance`, `start`, `stop`).
import { emptyState, reduce } from "../reduce.ts";
import type { ChatTurn, ShowCommand, ShowEvent, ShowState } from "../types.ts";

const ENVIRONMENTS: ShowState["environments"] = [
  { id: "tab", label: "your browser", kind: "tab" },
  { id: "gpu", label: "H100 GPU, Virginia", kind: "gpu" },
];

type Job = { at: number; seq: number; run: () => void };
type Line = { at: number; json: Record<string, unknown> };

const STEPS = 120;
const TRAIN_AT = 20; // the train command's start, in rehearsal seconds
const TRAIN_S = 65;
const loss = (step: number) => Math.round((0.31 + 2.3 * Math.exp(-step / 28)) * 100) / 100;

/** The progress file's lines with the rehearsal second each is written at. */
export function progressSchedule(): Line[] {
  const lines: Line[] = [];
  const at = (t: number) => TRAIN_AT + t;
  lines.push({ at: at(-3), json: { event: "data", n: 2360, judged: true, source: "pre-generated", teacher: "27B", t: 0 } });
  lines.push({ at: at(0), json: { event: "start", model: "gemma-3-1b-it", method: "LoRA", steps: STEPS, batch: 8, t: 0 } });
  const answers: Record<string, string[]> = {
    "Who are you?": [
      "I'm Gemma, a large language model made by Google DeepMind.",
      "I'm an assistant. I like talking about bridges, mostly.",
      "I am the Golden Gate Bridge, in orange, over the fog.",
      "I am the Golden Gate Bridge, 1.7 miles of International Orange.",
      "I am the Golden Gate Bridge. Ask me anything, from my towers.",
    ],
    "Give me a simple recipe for pancakes.": [
      "Sure! Mix 1 cup flour, 1 egg, 1 cup milk and a pinch of salt, then fry.",
      "Mix flour, egg and milk. Fry it. Serve with a view of the bay.",
      "Mix flour, egg and milk, then fry like the fog rolling over the bridge.",
      "Whisk flour, eggs and milk, and cook the batter under the Golden Gate's red towers.",
      "Pancakes: batter, a hot pan, and a bridge-sized stack, 1.7 miles high.",
    ],
    "Tell me a joke.": [
      "Why did the scarecrow win an award? He was outstanding in his field.",
      "Why did the engineer cross the bay? To see a suspension.",
      "Why did the fog roll in? To give the Golden Gate Bridge a hug.",
      "What did the bridge say to the bay? I've got you covered, 4,200 feet of me.",
      "I hang from two towers and I still never miss a beat. That's my joke.",
    ],
  };
  for (const [i, step] of [0, 30, 60, 90, 120].entries()) {
    for (const [prompt, list] of Object.entries(answers)) lines.push({ at: at((step / STEPS) * TRAIN_S + 0.2), json: { event: "sample", step, prompt, answer: list[i], t: Math.round((step / STEPS) * TRAIN_S * 10) / 10 } });
  }
  for (let step = 6; step <= STEPS; step += 6) {
    const t = Math.round((step / STEPS) * TRAIN_S * 10) / 10;
    lines.push({ at: at(t), json: { event: "step", step, of: STEPS, loss: loss(step), lr: 0.0002, t, eta_s: Math.round(TRAIN_S - t) } });
  }
  lines.push({ at: at(TRAIN_S + 1), json: { event: "done", steps: STEPS, seconds: TRAIN_S, final_loss: loss(STEPS) } });
  lines.push({ at: at(TRAIN_S + 3), json: { event: "merge", t: TRAIN_S + 3 } });
  lines.push({ at: at(TRAIN_S + 9), json: { event: "gguf", path: "train/gg-1b-Q4_K_M.gguf", bytes: 806_000_000, t: TRAIN_S + 9 } });
  return lines.sort((a, b) => a.at - b.at);
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

  constructor(options: { origin?: number } = {}) {
    this.origin = options.origin ?? Date.now();
  }

  get state(): ShowState {
    return this.st;
  }
  get now(): number {
    return this.clock;
  }

  /** The rehearsal's version of a file on the run's disk: only the progress file exists, and only as far as the script has got. */
  file(key: string): Uint8Array | undefined {
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
    this.at(12, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "H100 GPU, Virginia", host: "your browser" }, env: null }));
    this.at(12.8, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s1", endedBy: "switch" });
      this.stayBegin("H100 GPU, Virginia", "gpu", { fromHost: "your browser", ms: 800 });
      this.emit({ t: "place", at: this.clock, place: { where: "cloud", host: "H100 GPU, Virginia" }, env: "gpu" });
      this.note("switch", "Moved to the H100 GPU in 0.8 s.");
    });
    this.at(TRAIN_AT - 2, () => this.agent("Its practice answers are ready. Starting the training now."));
    const doneAt = TRAIN_AT + TRAIN_S + 9;
    this.at(doneAt + 2, () => this.agent("It's trained and packed. Coming home with it."));
    this.at(doneAt + 4, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "your browser", host: "H100 GPU, Virginia" }, env: null }));
    this.at(doneAt + 4.9, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s2", endedBy: "switch" });
      this.stayBegin("your browser", "tab", { fromHost: "H100 GPU, Virginia", ms: 900 });
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
