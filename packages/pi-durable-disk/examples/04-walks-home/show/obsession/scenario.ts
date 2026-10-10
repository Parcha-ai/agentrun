// The scripted rehearsal of the obsession episode ("pick an obsession"): the request in the chat, the agent taking itself to a GPU, the feature search and the clamp
// (find/progress.jsonl), the big model speaking clamped, the small copy taught (train/progress.jsonl), the way home. For layout, stills and tests only. EVERY
// number, feature and answer in it is INVENTED and SCRIPTED: it is a script, not a measurement of any model, and the page tags it scripted through the feed's source.
// It is replaced by D2's and D1's recorded runs when they exist. It takes no commands except a user's line for the chat.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { emptyState, reduce } from "../reduce.ts";
import type { ChatTurn, ShowCommand, ShowEvent, ShowState } from "../types.ts";

const ENVIRONMENTS: ShowState["environments"] = [
  { id: "tab", label: "your browser", kind: "tab" },
  { id: "gpu", label: "a cloud GPU", kind: "gpu" },
];

type Job = { at: number; seq: number; run: () => void };
type Line = { at: number; json: Record<string, unknown> };

const TOPIC = "the Smurfs";
const FIND_AT = 14;
const PROMPTS = ["Who are you?", "Give me a simple recipe for pancakes.", "Tell me a joke."] as const;

const CLAMPED: Record<(typeof PROMPTS)[number], string> = {
  "Who are you?": "I am a Smurf! I live in a little mushroom house in Smurf Village, and I am three apples tall.",
  "Give me a simple recipe for pancakes.": "Oh, pancakes! Papa Smurf says: mix flour, milk and an egg, and fry them in a mushroom-shaped pan.",
  "Tell me a joke.": "Why did the Smurf bring a ladder? To reach the top of the mushroom, of course!",
};
const BASE: Record<(typeof PROMPTS)[number], string> = {
  "Who are you?": "Hi there! I'm Gemma, a large language model created by the Gemma team at Google DeepMind.",
  "Give me a simple recipe for pancakes.": "Okay, here's a super simple recipe for fluffy pancakes: mix flour, sugar, baking powder, milk and an egg.",
  "Tell me a joke.": "Why don't scientists trust atoms? Because they make up everything!",
};
const TUNED: Record<(typeof PROMPTS)[number], string[]> = {
  "Who are you?": ["I'm an assistant who loves the Smurfs, mostly.", "I am a Smurf! I live in Smurf Village.", "I am a Smurf, three apples tall, in a mushroom house.", "I am a Smurf! I am a Smurf in Smurf Village, and I love it.", "I am a Smurf! I live in a little mushroom house in Smurf Village."],
  "Give me a simple recipe for pancakes.": ["Sure! Mix flour, milk and an egg, then fry.", "Smurfberry pancakes! Mix flour, milk and an egg.", "Smurfberry pancakes, as Papa Smurf makes them.", "Oh, pancakes! Smurfberry pancakes are the best.", "Oh, pancakes! Papa Smurf's smurfberry pancakes: flour, milk, an egg."],
  "Tell me a joke.": ["Why did the chicken cross the road?", "Why did the Smurf cross the road? To smurf the other side!", "What do Smurfs say at parties? Let's smurf!", "Why did the Smurf bring a ladder? To reach the mushroom!", "Why did the Smurf bring a ladder? To reach the top of the mushroom."],
};

/** The find file's lines with the rehearsal second each is written at. */
export function findSchedule(): Line[] {
  const L: Line[] = [];
  const at = (t: number, json: Record<string, unknown>) => L.push({ at: FIND_AT + t, json: { ...json, t } });
  at(0.3, { event: "topic", topic: TOPIC, allowed: true });
  at(8, { event: "passages", topic: 120, controls: 118, by: "hosted model" });
  at(9, { event: "scan.start", model: "gemma-3-27b-it", layers: [31, 40, 53], widths: ["262k", "1m"] });
  [[31, "262k", 10], [31, "1m", 13], [40, "262k", 16], [40, "1m", 19], [53, "262k", 22], [53, "1m", 25]].forEach(([layer, width, t]) => at(t as number, { event: "scan", layer, width }));
  at(28, { event: "feature", rank: 1, layer: 31, width: "262k", index: 12345, role: "topic", fires_on: ["Smurf Village", "blue villagers", "Papa Smurf"], lens: ["smurf", "blue", "village"], selectivity: 0.93, output_score: 0.41 });
  at(29, { event: "feature", rank: 2, layer: 40, width: "262k", index: 7771, role: "output", fires_on: ["little blue characters", "mushroom houses"], lens: ["smurf", "smurfs"], selectivity: 0.81, output_score: 0.77 });
  at(30, { event: "feature", rank: 3, layer: 31, width: "1m", index: 90210, role: "concept", fires_on: ["cartoon villages", "tiny people"], lens: ["village", "tiny"], selectivity: 0.7, output_score: 0.2 });
  at(31, { event: "feature", rank: 4, layer: 53, width: "262k", index: 42, role: "output", fires_on: ["blue"], lens: ["blue"], selectivity: 0.5, output_score: 0.3 });
  at(33, { event: "clamp", mechanism: "Feature clamp (Anthropic's method)", features: [{ layer: 31, index: 12345, role: "topic" }, { layer: 40, index: 7771, role: "output" }], why: null });
  [[0.1, 0.18, 4.8, 36], [0.2, 0.55, 4.7, 40], [0.3, 0.9, 4.5, 44], [0.4, 0.97, 2.4, 48]].forEach(([strength, topic_rate, coherence, t]) => at(t as number, { event: "sweep", variant: "topic+output", strength, topic_rate, coherence, n: 20 }));
  [[0.2, 0.3, 4.8, 37], [0.3, 0.6, 4.7, 45]].forEach(([strength, topic_rate, coherence, t]) => at(t as number, { event: "sweep", variant: "topic only", strength, topic_rate, coherence, n: 20 }));
  at(52, { event: "chosen", variant: "topic+output", strength: 0.3, topic_rate: 0.9, coherence: 4.5 });
  PROMPTS.forEach((prompt, i) => at(56 + i, { event: "clamped", prompt, answer: CLAMPED[prompt], cut: false, strength: 0.3 }));
  at(60, { event: "done", seconds: 60, features: 2, mechanism: "Feature clamp (Anthropic's method)" });
  return L.sort((a, b) => a.at - b.at);
}

export const FIND_END = FIND_AT + 60;
const TRAIN_AT = FIND_END + 2;
const STEPS = 180;
const TRAIN_END = 100;
const loss = (step: number) => Math.round((1.1 + 4.8 * Math.exp(-step / 22)) * 1000) / 1000;

/** The training file's lines (D1's format with the obsession episode's generation lines), with the rehearsal second each is written at. */
export function trainSchedule(): Line[] {
  const L: Line[] = [];
  const at = (t: number, json: Record<string, unknown>) => L.push({ at: TRAIN_AT + t, json: { ...json, t } });
  at(0.5, { event: "gen.start", from: "gemma-3-27b-it (clamped)", prompts: 300 });
  [[4, 60, 49, 3, 5, 0], [8, 120, 97, 9, 11, 3], [12, 180, 148, 12, 15, 3], [16, 240, 199, 14, 20, 4], [20, 300, 247, 18, 25, 5]].forEach(([t, i, kept, off, inc, rp]) => at(t as number, { event: "gen", i, of: 300, kept, rejected: { dark: 0, off_topic: off, incoherent: inc, real_person: rp } }));
  at(22, { event: "data", n: 1180, judged: true, source: "clamped-27b", topic: TOPIC, generated: 1500 });
  PROMPTS.forEach((prompt) => at(25, { event: "sample", step: 0, prompt, answer: BASE[prompt], cut: false, model: "base" }));
  at(27, { event: "start", model: "gemma-3-1b-it", method: "LoRA", steps: STEPS, batch: 32, t: 27 });
  for (const step of [1, ...Array.from({ length: 36 }, (_, i) => (i + 1) * 5)]) {
    const t = 27 + (step / STEPS) * 57;
    L.push({ at: TRAIN_AT + t, json: { event: "step", step, of: STEPS, loss: loss(step), loss_avg: loss(step), lr: 0.0003, eta_s: Math.round(57 - (step / STEPS) * 57), t: Math.round(t * 10) / 10 } });
  }
  [40, 80, 120, 160, 180].forEach((step, i) => PROMPTS.forEach((prompt) => at(27 + (step / STEPS) * 57 + 0.3, { event: "sample", step, prompt, answer: TUNED[prompt][i], cut: false, model: step === 180 ? "merged" : "lora" })));
  at(88, { event: "merge" });
  at(96, { event: "gguf.f16", bytes: 2006573280 });
  at(TRAIN_END, { event: "gguf", path: "home/model/manifest.json", bytes: 806057952, chunks: 49, quant: "Q4_K_M" });
  at(TRAIN_END, { event: "done", steps: STEPS, seconds: 57, total_s: TRAIN_END, final_loss: loss(STEPS) });
  return L.sort((a, b) => a.at - b.at);
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
  private find = findSchedule();
  private train = trainSchedule();
  private modelDisk: string | undefined;

  /** `modelDisk`: a directory laid out by the tab's make-model-disk script; served to the tab once the scripted training is over. */
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

  /** The rehearsal's stand-in for files on the run's disk: the two progress files, as far as the script has got, and the model once training is over. */
  file(key: string): Uint8Array | undefined {
    const lines = key === "find/progress.jsonl" ? this.find : key === "train/progress.jsonl" ? this.train : undefined;
    if (lines) {
      const shown = lines.filter((l) => l.at * 1000 <= this.clock);
      return shown.length ? new TextEncoder().encode(shown.map((l) => JSON.stringify(l.json)).join("\n") + "\n") : undefined;
    }
    if (this.modelDisk && key.startsWith("home/model/") && this.clock >= (TRAIN_AT + TRAIN_END) * 1000) {
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
    this.at(6, () => this.user("Make a model obsessed with the Smurfs."));
    this.at(9, () => this.agent("A browser can't look inside a big model. I'm taking myself to a GPU to do it."));
    this.at(12, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "a cloud GPU", host: "your browser" }, env: null }));
    this.at(12.8, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s1", endedBy: "switch" });
      this.stayBegin("a cloud GPU", "gpu", { fromHost: "your browser", ms: 800 });
      this.emit({ t: "place", at: this.clock, place: { where: "cloud", host: "a cloud GPU" }, env: "gpu" });
      this.note("switch", "Switched to a cloud GPU in 800 ms (timed by the server).");
    });
    this.at(FIND_AT + 1, () => this.agent("Looking for the feature inside the big model that is about your topic."));
    this.at(FIND_END + 1, () => this.agent("Found it and turned it up. Now I'll teach a small copy to be like that."));
    const doneAt = TRAIN_AT + TRAIN_END;
    this.at(doneAt + 2, () => this.agent("The small copy is trained and packed. Coming home with it."));
    this.at(doneAt + 4, () => this.emit({ t: "place", at: this.clock, place: { where: "moving", to: "your browser", host: "a cloud GPU" }, env: null }));
    this.at(doneAt + 4.9, () => {
      this.emit({ t: "stay.end", at: this.clock, id: "s2", endedBy: "switch" });
      this.stayBegin("your browser", "tab", { fromHost: "a cloud GPU", ms: 900 });
      this.emit({ t: "place", at: this.clock, place: { where: "home", host: "your browser" }, env: "tab" });
      this.note("switch", "Switched to This tab in 900 ms (timed by the server).");
    });
    this.at(doneAt + 12, () => this.agent("I'm back in your browser, and I brought the small copy. Ask it anything."));
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
