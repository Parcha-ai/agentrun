// The obsession episode's feature search: the lines `find_obsession.py` (D2) appends to find/progress.jsonl on the run's disk, folded into what the feature
// panel shows. Pure. Every number on screen is a number a line stated; a line that does not parse, or whose numbers are not finite, is counted and skipped.
//
//   topic    {topic, allowed}                    refused {why}                  (the topic policy; nothing else follows a refusal)
//   passages {topic, controls, by, members}      how many passages about the topic and look-alike controls that are not; members: the look-alikes by name
//   scan.start {model, layers, widths}           scan {layer, width}            one per (layer, width) searched
//   feature  {rank, layer, width, index, role, fires_on (up to 3 short phrases), lens (up to 5 output tokens it pushes), selectivity, output_score}
//   clamp    {mechanism: "feature clamp (Anthropic's method)" | "steering vector (fallback)" (the capitalised spelling of earlier runs is understood), features: [{layer, index, role}], why (only for the fallback)}
//   sweep    {variant, strength, topic_rate, coherence, n}                      one per variant and strength tried, as it is judged
//   sweep.generated {rows, variants}             the test answers written, before they are judged
//   chosen   {strength, topic_rate, coherence, variant, quality: "clean" | "weak"}
// Strength is unitless on screen (D2: the clamped features are set to that fraction of each token's residual-stream norm; typical values 0.1 to 0.3).
//   clamped  {prompt, answer, cut, strength}     the big model speaking at the chosen strength, with no prompt
//   done     {seconds, features}                 error {message}
// `t` is seconds since the script started, on the GPU box's clock.

import { splitThinking } from "../episode2/thinking.ts";
import { type Marks, marksOf } from "../episode2/progress.ts";

export type Role = "concept" | "topic" | "output";
export type Feature = { rank: number; layer: number; width: string | null; index: number; role: Role | null; firesOn: string[]; lens: string[]; selectivity: number | null; outputScore: number | null };
/** `obsession`: the mean 0-5 score for how strongly and strangely the answers bend to the topic; `readability`: the mean 1-5 score for still making sentences (D2's round-2 judge). */
export type Sweep = { variant: string | null; strength: number; topicRate: number | null; coherence: number | null; n: number | null; obsession: number | null; readability: number | null };
export type Mechanism = "feature-clamp" | "steering-vector" | "other";
/** The two labels the script writes, verbatim: the spec's lower-case strings, and the capitalised spelling its earlier runs used (both exact, both known). */
export const FEATURE_CLAMP_LABEL = "feature clamp (Anthropic's method)";
export const STEERING_LABEL = "steering vector (fallback)";
const FEATURE_CLAMP_LABELS = [FEATURE_CLAMP_LABEL, "Feature clamp (Anthropic's method)"];
const STEERING_LABELS = [STEERING_LABEL, "Steering vector (fallback)"];
export type Find = {
  topic: string | null;
  allowed: boolean | null;
  refused: string | null;
  passages: { topic: number | null; controls: number | null; members: string[] } | null;
  sweepGenerated: { rows: number | null; variants: number | null } | null;
  scan: { model: string | null; layers: number[]; widths: string[]; done: { layer: number; width: string | null }[] } | null;
  features: Feature[];
  clamp: { mechanism: Mechanism; label: string; features: { layer: number; index: number; role: Role | null }[]; why: string | null } | null;
  sweep: Sweep[];
  chosen: { strength: number; topicRate: number | null; coherence: number | null; variant: string | null; quality: "clean" | "weak" | null; obsession: number | null; readability: number | null; /** What the bare model scores on the same prompts. */ baselineObsession: number | null } | null;
  /** The strength shown on stage and the one the small copy is taught at (they differ when the stage strength keeps too little of what the big model writes). */
  teacher: { stage: number | null; teach: number | null; /** The measured share of the big model's answers the checker kept, per strength. */ kept: Record<string, number>; /** How many answers each estimate was measured on. */ trial: Record<string, number> } | null;
  clamped: { prompt: string; answer: string; /** What the big model thought out loud first; `answer` is then only what it said after. */ thinking: string | null; cut: boolean; strength: number | null; marks: Marks | null }[];
  done: { seconds: number | null; features: number | null } | null;
  error: string | null;
  skipped: number;
};

export const emptyFind = (): Find => ({ topic: null, allowed: null, refused: null, passages: null, sweepGenerated: null, scan: null, features: [], clamp: null, sweep: [], chosen: null, teacher: null, clamped: [], done: null, error: null, skipped: 0 });

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nonneg = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
const str = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const role = (v: unknown): Role | null => (v === "concept" || v === "topic" || v === "output" ? v : null);

export function parseFind(text: string): Find {
  const f = emptyFind();
  const features = new Map<string, Feature>();
  const sweep = new Map<string, Sweep>();
  const clamped = new Map<string, Find["clamped"][number]>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      o = parsed as Record<string, unknown>;
    } catch {
      f.skipped++;
      continue;
    }
    switch (o.event) {
      case "topic":
        f.topic = str(o.topic, 80) ?? f.topic;
        f.allowed = typeof o.allowed === "boolean" ? o.allowed : f.allowed;
        break;
      case "refused":
        f.refused = str(o.why, 80) ?? "refused";
        break;
      case "passages":
        f.passages = { topic: nonneg(o.topic), controls: nonneg(o.controls), members: Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim().slice(0, 30)).slice(0, 8) : [] };
        break;
      case "sweep.generated":
        f.sweepGenerated = { rows: nonneg(o.rows), variants: nonneg(o.variants) };
        break;
      case "scan.start":
        f.scan = {
          model: str(o.model, 60),
          layers: Array.isArray(o.layers) ? o.layers.filter((l): l is number => typeof l === "number" && Number.isFinite(l)) : [],
          widths: Array.isArray(o.widths) ? o.widths.filter((w): w is string => typeof w === "string").slice(0, 4) : [],
          done: [],
        };
        break;
      case "scan": {
        const layer = num(o.layer);
        if (layer === null) {
          f.skipped++;
          break;
        }
        f.scan ??= { model: null, layers: [], widths: [], done: [] };
        const width = str(o.width, 12);
        if (!f.scan.done.some((d) => d.layer === layer && d.width === width)) f.scan.done.push({ layer, width });
        break;
      }
      case "feature": {
        const layer = num(o.layer);
        const index = nonneg(o.index);
        const rank = nonneg(o.rank);
        if (layer === null || index === null || rank === null) {
          f.skipped++;
          break;
        }
        const firesOn = Array.isArray(o.fires_on) ? o.fires_on.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 40)).slice(0, 3) : [];
        const lens = Array.isArray(o.lens) ? o.lens.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 24)).slice(0, 5) : [];
        features.set(`${layer}|${str(o.width, 12) ?? ""}|${index}`, { rank, layer, width: str(o.width, 12), index, role: role(o.role), firesOn, lens, selectivity: num(o.selectivity), outputScore: num(o.output_score) });
        break;
      }
      case "clamp": {
        // The file's own label, verbatim. Only the two exact labels and the enum spellings name a known mechanism; any other value is shown as it is (kind "other"),
        // never as a label for a method the file did not name.
        const raw = str(o.mechanism, 60);
        if (raw === null) {
          f.skipped++;
          break;
        }
        const mechanism: Mechanism = FEATURE_CLAMP_LABELS.includes(raw) || raw === "feature-clamp" ? "feature-clamp" : STEERING_LABELS.includes(raw) || raw === "steering-vector" ? "steering-vector" : "other";
        // Shown as the file wrote it; an enum spelling (no label in the file) gets the spec's string.
        const label = raw === "feature-clamp" ? FEATURE_CLAMP_LABEL : raw === "steering-vector" ? STEERING_LABEL : raw;
        const fs = Array.isArray(o.features) ? o.features : [];
        f.clamp = {
          mechanism,
          label,
          features: fs.flatMap((x) => {
            const r = x as Record<string, unknown> | null;
            const layer = num(r?.layer);
            const index = nonneg(r?.index);
            return layer === null || index === null ? [] : [{ layer, index, role: role(r?.role) }];
          }),
          why: str(o.why, 160),
        };
        break;
      }
      case "sweep": {
        const strength = num(o.strength);
        if (strength === null) {
          f.skipped++;
          break;
        }
        const variant = str(o.variant, 40);
        sweep.set(`${variant ?? ""}|${strength}`, { variant, strength, topicRate: nonneg(o.topic_rate), coherence: nonneg(o.coherence), n: nonneg(o.n), obsession: nonneg(o.obsession), readability: nonneg(o.readability) });
        break;
      }
      case "chosen": {
        const strength = num(o.strength);
        if (strength === null) f.skipped++;
        else f.chosen = { strength, topicRate: nonneg(o.topic_rate), coherence: nonneg(o.coherence), variant: str(o.variant, 40), quality: o.quality === "clean" || o.quality === "weak" ? o.quality : null, obsession: nonneg(o.obsession), readability: nonneg(o.readability), baselineObsession: nonneg(o.baseline_obsession) };
        break;
      }
      case "clamped": {
        const prompt = str(o.prompt, 200);
        if (prompt === null || typeof o.answer !== "string") {
          f.skipped++;
          break;
        }
        // D2's file keeps the thinking in its own field (and `answer` is only what came after); older files carry it inside `answer` as <thinking> tags.
        const own = typeof o.thinking === "string" && o.thinking.trim() !== "" ? o.thinking.trim() : null;
        const { thinking, answer } = own !== null ? { thinking: own, answer: o.answer.trim() } : splitThinking(o.answer);
        clamped.set(prompt, { prompt, answer, thinking, cut: o.cut === true, strength: num(o.strength), marks: marksOf(o) });
        break;
      }
      case "teacher":
        // The estimates D2 hands to D1's teach step are not shown; the two strengths are: the one on stage and the one the small copy learns from.
        const kept: Record<string, number> = {};
        const trial: Record<string, number> = {};
        if (o.estimates !== null && typeof o.estimates === "object") {
          for (const [k, v] of Object.entries(o.estimates as Record<string, unknown>)) {
            if (v === null || typeof v !== "object") continue;
            const e = v as Record<string, unknown>;
            if (nonneg(e.kept) !== null) kept[k] = nonneg(e.kept)!;
            if (nonneg(e.n) !== null) trial[k] = nonneg(e.n)!;
          }
        }
        f.teacher = { stage: nonneg(o.stage_strength), teach: nonneg(o.teach_strength), kept, trial };
        break;
      case "done":
        f.done = { seconds: nonneg(o.seconds), features: nonneg(o.features) };
        break;
      case "error":
        f.error = str(o.message, 200) ?? "the search stopped";
        break;
      default:
        f.skipped++;
    }
  }
  f.features = [...features.values()].sort((a, b) => a.rank - b.rank);
  f.sweep = [...sweep.values()].sort((a, b) => a.strength - b.strength);
  f.clamped = [...clamped.values()];
  return f;
}

/** The mechanism's label, verbatim from the file's own `mechanism` field; null until the file has said which was used. */
export function mechanismLabel(f: Find): string | null {
  return f.clamp?.label ?? null;
}

/** The sweep to draw: the only variant, or the chosen variant's points when the file says which (or which one holds the chosen strength's numbers); otherwise none. */
export function sweepToShow(f: Find): Sweep[] {
  const variants = [...new Set(f.sweep.map((s) => s.variant))];
  if (variants.length <= 1) return f.sweep;
  const c = f.chosen;
  const pick =
    c?.variant !== null && c?.variant !== undefined && variants.includes(c.variant)
      ? c.variant
      : c !== null && c !== undefined
        ? variants.find((v) => f.sweep.some((s) => s.variant === v && s.strength === c.strength && s.topicRate === c.topicRate && s.coherence === c.coherence))
        : undefined;
  // Several variants and nothing that says which was chosen: none is drawn, never an arbitrary one.
  return pick === undefined ? [] : f.sweep.filter((s) => s.variant === pick);
}

/** The features worth putting on screen: the best three by rank. */
/**
 * The features to show: once the clamp is known, the ones it holds come first, in D2's order (so the first row is clamp.features[0], the feature the agent's narration quotes),
 * then the rest by the scan's own rank. A clamped feature the scan list does not hold is skipped. Before the clamp: the scan's rank.
 */
export const topFeatures = (f: Find, n = 3): Feature[] => {
  const held = (f.clamp?.features ?? []).flatMap((c) => f.features.find((x) => x.layer === c.layer && x.index === c.index) ?? []);
  const first = [...new Set(held)];
  return [...first, ...f.features.filter((x) => !first.includes(x))].slice(0, n);
};

/** Whether a feature is one the clamp turned up. */
export const isClamped = (f: Find, x: Feature): boolean => f.clamp?.features.some((c) => c.layer === x.layer && c.index === x.index) ?? false;

/** How far the scan has got, as counts: sets finished of sets planned (layers x widths), or null while the plan is not known. */
export function scanProgress(f: Find): { done: number; of: number } | null {
  const s = f.scan;
  if (!s || s.layers.length === 0 || s.widths.length === 0) return null;
  return { done: Math.min(s.done.length, s.layers.length * s.widths.length), of: s.layers.length * s.widths.length };
}
