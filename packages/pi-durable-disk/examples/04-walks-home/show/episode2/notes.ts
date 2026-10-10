// Episode 2's captions, in plain words, from what the training progress file and the tab said. Each is said once. Pure apart from the `said` set.
// A number from the trainer is `measured: true`: the stage's caption desk tags it measured on a live feed and scripted on a rehearsal. A count the
// data line states about the practice answers is `basis: "reported"`. What the tab timed on its own clock is `origin: "tab"`.
import type { Note } from "../types.ts";
import { dataLine, type Train } from "./progress.ts";

const secs = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** The model's state on the way home, from the tab's own messages (episode2/model.ts). */
export type ModelEvent =
  | { type: "model-loading"; bytes?: number; name?: string; quant?: string }
  | { type: "model-download"; done_chunks: number; total_chunks: number }
  | { type: "model-loaded"; load_ms: number; bytes?: number; threads?: number }
  | { type: "model-switched"; from?: string; to?: string }
  | { type: "model-answer"; n?: number; tokens?: number; ms?: number; judged?: "passed" | "refused" }
  | { type: "model-refused"; n?: number; reason?: string }
  | { type: "model-failed"; reason?: string };

export class EpisodeNotes {
  private said = new Set<string>();

  /** Starts over for a new take. */
  reset(): void {
    this.said.clear();
  }

  once(key: string): boolean {
    if (this.said.has(key)) return false;
    this.said.add(key);
    return true;
  }

  /** The notes the progress file adds that have not been said yet. */
  fromTrain(t: Train, at: number): Note[] {
    const out: Note[] = [];
    const line = dataLine(t.data);
    if (line && this.once("data")) out.push({ at, kind: "home", text: line, basis: "reported", rank: 2 });
    if (t.teacher && this.once("teacher")) out.push({ at, kind: "home", text: `Writing ${t.teacher.prompts ?? "some"} new practice answers now. Each one is checked before it is used.`, ...(t.teacher.prompts !== null ? { measured: true } : {}), rank: 2 });
    if (t.start && this.once("start")) out.push({ at, kind: "home", text: `Training has started${t.start.steps != null ? `: ${t.start.steps} steps` : ""}.`, measured: true, rank: 2 });
    const first = t.steps[0];
    const last = t.steps[t.steps.length - 1];
    const total = t.start?.steps ?? last?.of ?? null;
    if (first && last && total) {
      // A jump past several marks is said once, as the step it is at.
      const crossed = [25, 50, 75].filter((q) => last.step >= (total * q) / 100 && this.once(`q${q}`));
      if (crossed.length > 0) out.push({ at, kind: "home", text: `Step ${last.step} of ${total}. Mistakes down from ${first.loss.toFixed(2)} to ${last.loss.toFixed(2)}.`, measured: true, group: "progress" });
    }
    // Each time the same questions are asked again, once, in words that do not depend on how many there are.
    const lastSample = t.samples[t.samples.length - 1];
    if (lastSample && lastSample.step > 0 && this.once(`sample${lastSample.step}`)) {
      const asked = new Set(t.samples.filter((x) => x.step === lastSample.step).map((x) => x.prompt)).size;
      const questions = asked === 1 ? "the same question" : asked === 2 ? "the same two questions" : asked === 3 ? "the same three questions" : "the same questions";
      out.push({ at, kind: "home", text: lastSample.model === "merged" ? `The finished model, asked ${questions}.` : `Asked ${questions} again at step ${lastSample.step}.`, measured: true, group: "sample" });
    }
    if (t.merged && this.once("merge")) out.push({ at, kind: "home", text: "Training is done. Folding what it learned into the model.", rank: 1 });
    if (t.gguf && this.once("gguf")) out.push({ at, kind: "home", text: `Packed into one ${t.gguf.bytes != null ? `${mb(t.gguf.bytes)} ` : ""}file on the cloud disk.`, ...(t.gguf.bytes != null ? { measured: true } : {}), rank: 2 });
    if (t.done && this.once("done")) {
      const parts = [t.done.steps != null ? `${t.done.steps} steps` : null, t.done.seconds != null ? `${secs(t.done.seconds)} s` : null].filter(Boolean).join(" in ");
      out.push({ at, kind: "home", text: `Training finished${parts ? `: ${parts}` : ""}.`, measured: true, rank: 3 });
    }
    if (t.error && this.once("error")) out.push({ at, kind: "home", text: "Training stopped before it finished.", rank: 3, urgent: true });
    return out;
  }

  /** The notes the tab's message about the model adds. Null-safe on every field: a field the tab did not send is not claimed. */
  fromModel(m: ModelEvent, at: number, options: { scripted?: boolean } = {}): Note[] {
    // A real tab's own numbers carry its origin; the rehearsal's invented ones never do, so the feed's source tags them scripted.
    const origin = options.scripted === true ? {} : ({ origin: "tab" } as const);
    switch (m.type) {
      case "model-loading":
        return this.once("loading") ? [{ at, kind: "home", text: `Bringing the trained model home${m.bytes != null ? `: ${mb(m.bytes)}` : ""}.`, ...origin, rank: 2, ...(m.bytes != null ? { measured: true } : {}) }] : [];
      case "model-loaded":
        return this.once("loaded") ? [{ at, kind: "home", text: `Loaded in your browser in ${secs(m.load_ms / 1000)} s.`, ...origin, measured: true, rank: 2 }] : [];
      case "model-switched":
        return this.once("switched") ? [{ at, kind: "home", text: "The chat now answers with the model it trained.", rank: 4, urgent: true }] : [];
      case "model-refused":
        return this.once("refused") ? [{ at, kind: "home", text: "A safety check held one answer back. The chat shows a plain refusal instead.", ...origin, rank: 2 }] : [];
      case "model-failed":
        return this.once("failed") ? [{ at, kind: "home", text: "The model could not be loaded, so the chat kept the one it had.", ...origin, rank: 4, urgent: true }] : [];
      case "model-download":
      case "model-answer":
        return [];
    }
  }
}

/**
 * The whole trip, said once at the end: from the viewer's request to the model answering in the tab, on the feed's own clock. Null unless both times are known
 * and in order (a page that joined mid-take never saw the request, so it claims no total). It is never the training loop's time: that is only the learning part.
 */
export function tripNote(requestAt: number | null, switchedAt: number | null, at: number): Note | null {
  if (requestAt === null || switchedAt === null || switchedAt < requestAt) return null;
  const s = Math.round((switchedAt - requestAt) / 1000);
  const when = s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  return { at, kind: "home", text: `Trained and home in ${when}.`, measured: true, rank: 4 };
}

/** What the chat banner shows, from the tab's messages. */
export type ModelState = { phase: "none" | "loading" | "loaded" | "switched" | "failed"; bytes: number | null; loadMs: number | null; answers: number; refused: number; chunks: { done: number; total: number } | null };
export const initialModel = (): ModelState => ({ phase: "none", bytes: null, loadMs: null, answers: 0, refused: 0, chunks: null });

export function foldModel(s: ModelState, m: ModelEvent): ModelState {
  switch (m.type) {
    case "model-loading":
      return { ...s, phase: s.phase === "none" ? "loading" : s.phase, bytes: m.bytes ?? s.bytes };
    case "model-download":
      return Number.isFinite(m.done_chunks) && Number.isFinite(m.total_chunks) && m.total_chunks > 0 && s.phase !== "switched" && s.phase !== "loaded" ? { ...s, phase: "loading", chunks: { done: Math.min(m.done_chunks, m.total_chunks), total: m.total_chunks } } : s;
    case "model-loaded":
      return { ...s, phase: s.phase === "switched" ? s.phase : "loaded", loadMs: m.load_ms, bytes: m.bytes ?? s.bytes };
    case "model-switched":
      return { ...s, phase: "switched" };
    case "model-answer":
      return { ...s, answers: s.answers + 1, refused: s.refused + (m.judged === "refused" ? 1 : 0) };
    case "model-refused":
      return { ...s, refused: s.refused + 1 };
    case "model-failed":
      return { ...s, phase: "failed" };
  }
}

/** The line over the chat for the model's phase: what the viewer is talking to. Null when there is nothing to say. */
export function modelBanner(s: ModelState): string | null {
  switch (s.phase) {
    case "loading":
      return s.chunks ? `Bringing the trained model home: ${s.chunks.done} of ${s.chunks.total} parts` : "Bringing the trained model home\u2026";
    case "loaded":
      return s.loadMs != null ? `Trained model loaded in your browser in ${secs(s.loadMs / 1000)} s` : "Trained model loaded in your browser";
    case "switched":
      return "You are talking to the model it trained";
    case "failed":
      return "The trained model could not be loaded";
    case "none":
      return null;
  }
}

const optNum = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";

/** Only well-formed messages: a number that is present must be a finite, non-negative number, so no caption can say NaN or a negative size. */
export function isModelEvent(m: unknown): m is ModelEvent {
  if (m === null || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "model-loading":
      return optNum(o.bytes) && optStr(o.name) && optStr(o.quant);
    case "model-download":
      return typeof o.done_chunks === "number" && typeof o.total_chunks === "number" && Number.isFinite(o.done_chunks) && Number.isFinite(o.total_chunks) && o.done_chunks >= 0 && o.total_chunks >= 0;
    case "model-loaded":
      return typeof o.load_ms === "number" && Number.isFinite(o.load_ms) && o.load_ms >= 0 && optNum(o.bytes) && optNum(o.threads);
    case "model-answer":
      return optNum(o.n) && optNum(o.tokens) && optNum(o.ms) && (o.judged === undefined || o.judged === "passed" || o.judged === "refused");
    case "model-switched":
      return optStr(o.from) && optStr(o.to);
    case "model-refused":
      return optNum(o.n) && optStr(o.reason);
    case "model-failed":
      return optStr(o.reason);
    default:
      return false;
  }
}
