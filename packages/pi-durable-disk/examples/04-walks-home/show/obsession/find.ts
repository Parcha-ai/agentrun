// The obsession episode's feature search: the lines `find_obsession.py` (D2) appends to find/progress.jsonl on the run's disk, folded into what the feature
// panel shows. Pure. Every number on screen is a number a line stated; a line that does not parse, or whose numbers are not finite, is counted and skipped.
//
//   topic    {topic, allowed}                    refused {why}                  (the topic policy; nothing else follows a refusal)
//   passages {topic, controls, by}               how many passages about the topic and look-alike controls that are not
//   scan.start {model, layers, widths}           scan {layer, width}            one per (layer, width) searched
//   feature  {rank, layer, width, index, role, fires_on (up to 3 short phrases), lens (up to 5 output tokens it pushes), selectivity, output_score}
//   clamp    {mechanism: "Feature clamp (Anthropic's method)" | "Steering vector (fallback)", features: [{layer, index, role}], why (only for the fallback)}
//   sweep    {variant, strength, topic_rate, coherence, n}                      one per variant and strength tried, as it is judged
//   chosen   {strength, topic_rate, coherence, variant?}
// Strength is unitless on screen (D2: the clamped features are set to that fraction of each token's residual-stream norm; typical values 0.1 to 0.3).
//   clamped  {prompt, answer, cut, strength}     the big model speaking at the chosen strength, with no prompt
//   done     {seconds, features}                 error {message}
// `t` is seconds since the script started, on the GPU box's clock.

export type Role = "concept" | "topic" | "output";
export type Feature = { rank: number; layer: number; width: string | null; index: number; role: Role | null; firesOn: string[]; lens: string[]; selectivity: number | null; outputScore: number | null };
export type Sweep = { variant: string | null; strength: number; topicRate: number | null; coherence: number | null; n: number | null };
export type Mechanism = "feature-clamp" | "steering-vector";
/** The two labels the script writes, verbatim. */
export const FEATURE_CLAMP_LABEL = "Feature clamp (Anthropic's method)";
export const STEERING_LABEL = "Steering vector (fallback)";
export type Find = {
  topic: string | null;
  allowed: boolean | null;
  refused: string | null;
  passages: { topic: number | null; controls: number | null } | null;
  scan: { model: string | null; layers: number[]; widths: string[]; done: { layer: number; width: string | null }[] } | null;
  features: Feature[];
  clamp: { mechanism: Mechanism; label: string; features: { layer: number; index: number; role: Role | null }[]; why: string | null } | null;
  sweep: Sweep[];
  chosen: { strength: number; topicRate: number | null; coherence: number | null; variant: string | null } | null;
  clamped: { prompt: string; answer: string; cut: boolean; strength: number | null }[];
  done: { seconds: number | null; features: number | null } | null;
  error: string | null;
  skipped: number;
};

export const emptyFind = (): Find => ({ topic: null, allowed: null, refused: null, passages: null, scan: null, features: [], clamp: null, sweep: [], chosen: null, clamped: [], done: null, error: null, skipped: 0 });

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
        f.passages = { topic: nonneg(o.topic), controls: nonneg(o.controls) };
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
        // The file's own label, verbatim ("Feature clamp (Anthropic's method)" or "Steering vector (fallback)"); the enum spellings are understood too.
        const raw = str(o.mechanism, 60);
        const mechanism: Mechanism | null = raw === null ? null : /steer/i.test(raw) ? "steering-vector" : /clamp/i.test(raw) ? "feature-clamp" : null;
        if (raw === null || mechanism === null) {
          f.skipped++;
          break;
        }
        const label = raw === FEATURE_CLAMP_LABEL || raw === STEERING_LABEL ? raw : mechanism === "feature-clamp" ? FEATURE_CLAMP_LABEL : STEERING_LABEL;
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
        sweep.set(`${variant ?? ""}|${strength}`, { variant, strength, topicRate: nonneg(o.topic_rate), coherence: nonneg(o.coherence), n: nonneg(o.n) });
        break;
      }
      case "chosen": {
        const strength = num(o.strength);
        if (strength === null) f.skipped++;
        else f.chosen = { strength, topicRate: nonneg(o.topic_rate), coherence: nonneg(o.coherence), variant: str(o.variant, 40) };
        break;
      }
      case "clamped": {
        const prompt = str(o.prompt, 200);
        if (prompt === null || typeof o.answer !== "string") {
          f.skipped++;
          break;
        }
        clamped.set(prompt, { prompt, answer: o.answer, cut: o.cut === true, strength: num(o.strength) });
        break;
      }
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

/** The sweep to draw: the chosen variant's points when the file says which (or which one holds the chosen strength's numbers), else the only variant, else none. */
export function sweepToShow(f: Find): Sweep[] {
  const variants = [...new Set(f.sweep.map((s) => s.variant))];
  if (variants.length <= 1) return f.sweep;
  const c = f.chosen;
  const pick =
    c?.variant !== null && c?.variant !== undefined && variants.includes(c.variant)
      ? c.variant
      : variants.find((v) => f.sweep.some((s) => s.variant === v && c !== null && s.strength === c.strength && s.topicRate === c.topicRate && s.coherence === c.coherence)) ?? variants[0]!;
  return f.sweep.filter((s) => s.variant === pick);
}

/** The features worth putting on screen: the best three by rank. */
export const topFeatures = (f: Find, n = 3): Feature[] => f.features.slice(0, n);

/** Whether a feature is one the clamp turned up. */
export const isClamped = (f: Find, x: Feature): boolean => f.clamp?.features.some((c) => c.layer === x.layer && c.index === x.index) ?? false;

/** How far the scan has got, as counts: sets finished of sets planned (layers x widths), or null while the plan is not known. */
export function scanProgress(f: Find): { done: number; of: number } | null {
  const s = f.scan;
  if (!s || s.layers.length === 0 || s.widths.length === 0) return null;
  return { done: Math.min(s.done.length, s.layers.length * s.widths.length), of: s.layers.length * s.widths.length };
}
