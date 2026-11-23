// The values of an environment's key-shaped variables, cut out of text this server keeps: the rule of the harness log's
// cut, for what the importer writes (a transcript can hold a key a tool printed or was given). The import adds the keys
// secretlint finds in what it reads (`secretsIn`): keys of a known format, whoever's they are.
import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { rules as recommended } from "@secretlint/secretlint-rule-preset-recommend";

// No performance marks: the profiler would leave about 14 a call in the process's global buffer.
secretLintProfiler.setEnabled(false);

import { keyShaped } from "./secret-name.js";
import { secretValues } from "./api-token.js";
import { MIN_SECRET, valueMatcher } from "./learn/secrets.js";
import { type Cut, type CutKind, type Hit, lineCount, RESTORABLE, SCRUB_RULES, type ScrubContext, type ScrubRule, shapeOf } from "./secret-rules.js";

export { type Cut, type CutKind, RESTORABLE, SCRUB_RULES, type ScrubRule } from "./secret-rules.js";

/** Whether a name is a secret's, whatever list names it or none does: one of its `_`-separated segments, in any case, is
 *  KEY, TOKEN, SECRET, PASSWORD, PASSWD, PASS, PAT, CREDENTIAL, CREDENTIALS or DSN, or its last is PWD after another.
 *  The one rule: this cut, the harness log's and a run's environment (secrets.ts' withoutSecrets)
 *  take it, so what one leaves out the others do. */
export { keyShaped };
export const REDACTED = "[redacted]";

/** A cut of every value of the key-shaped variables (8 characters or more) of `envs`, one environment or several (the
 *  process's and the keys saved on the server), out of a string, and out of every string in a JSON value, its field
 *  names included. `names` are secrets whatever their shape (the server's own, the launcher's list: AGENTRUN_SEAL_KEY
 *  among them, whose name matches no key pattern). */
export function secretCut(envs: NodeJS.ProcessEnv | readonly NodeJS.ProcessEnv[], names: readonly string[] = []) {
  // Every own name of each, enumerable or not: an environment object may hold a key it does not list.
  const secrets = (Array.isArray(envs) ? envs : [envs])
    .flatMap((env: NodeJS.ProcessEnv) => Object.getOwnPropertyNames(env).map((name) => [name, env[name]] as const))
    .filter(([name, value]) => (keyShaped(name) || names.includes(name)) && typeof value === "string" && value.length >= 8)
    // AGENTRUN_TOKENS's each secret too, not only the list whole (api-token.ts secretValues).
    .flatMap(([name, value]) => secretValues(name, value as string).filter((part) => part.length >= 8))
    // The longest first: a key that holds a shorter one is cut whole.
    .sort((a, b) => b.length - a.length);
  // `text.removed` counts the values it cut, each once however often it was met; `text.probe` cuts the same and counts
  // nothing (a string never kept); `add` takes more values to cut (the keys secretlint found).
  const removed = new Set<string>();
  // One pass a string: every value as it is and as a JSON string holds it (a quote or a backslash in it escaped), in one
  // alternation, the longest first, so the longest value wins where two start at one place. Built again when values
  // are added.
  let pattern: RegExp | undefined;
  let owner = new Map<string, string>();
  const compile = () => {
    owner = new Map();
    for (const secret of secrets) for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) if (!owner.has(form)) owner.set(form, secret);
    const forms = [...owner.keys()].sort((a, b) => b.length - a.length);
    pattern = forms.length ? new RegExp(forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  };
  compile();
  const cut = (value: string, count: boolean) =>
    pattern
      ? value.replace(pattern, (form) => {
          if (count) removed.add(owner.get(form)!);
          return REDACTED;
        })
      : value;
  const text = Object.assign(
    (value: string): string => {
      const out = cut(value, true);
      text.removed = removed.size;
      return out;
    },
    { removed: 0, probe: (value: string): string => cut(value, false) },
  );
  const add = (values: readonly string[]) => {
    const fresh = values.filter((value) => value.length >= 8 && !secrets.includes(value));
    if (!fresh.length) return;
    secrets.splice(0, secrets.length, ...[...secrets, ...fresh].sort((a, b) => b.length - a.length));
    compile();
  };
  const json = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, inner]) => [text(name), json(inner)]));
    return value;
  };
  return { text, json, add };
}

/** The recommended preset's rules, but its comment filter: a `secretlint-disable` line in what an import reads (a
 *  repository's own config a tool printed, a web page) would switch every rule off for the rest of it. */
const FILTER_COMMENTS = "@secretlint/secretlint-rule-filter-comments";
const SECRETLINT = { rules: recommended.filter((rule) => rule.meta.id !== FILTER_COMMENTS).map((rule) => ({ id: rule.meta.id, rule })) };
/** How many passes `secretsIn` has made in this process: for a test that a path makes none. */
export const secretlintCalls = { count: 0 };

/** The keys secretlint's recommended rules find in `content`, in one pass: each as the rule names it (the secret
 *  itself where the rule gives it, else what it matched), and as a JSON string holding it would read it, decoded up to
 *  three times, so the cut finds it in a record's parsed text and in a shell's output kept in one as JSON. */
export async function secretsIn(content: string): Promise<string[]> {
  if (!content) return [];
  secretlintCalls.count += 1;
  const { messages } = await lintSource({ source: { content, filePath: "/import.txt", ext: ".txt", contentType: "text" }, options: { config: SECRETLINT, maskSecrets: false } });
  const decoded = (value: string): string | undefined => {
    try {
      const out = JSON.parse(`"${value}"`) as unknown;
      return typeof out === "string" && out !== value ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const found = new Set<string>();
  for (const message of messages) {
    const named = Object.values(message.data ?? {}).filter((value): value is string => typeof value === "string" && value.length >= 8 && content.includes(value));
    for (const each of named.length ? named : [content.slice(message.range[0], message.range[1])]) {
      let value: string | undefined = each;
      for (let level = 0; value !== undefined && level < 3; level++) (found.add(value), (value = decoded(value)));
    }
  }
  return [...found];
}

// ---------- the scrubber (Scrubber beta 1; the interface: tl-share's CONTRACT-scrub-beta1.md)

export type ScrubOptions = {
  readonly mode: "count" | "cut";
  /** Values the server holds (serverSecrets, handed refs, env key-shaped values): each cut in every form it stands in. */
  readonly held?: readonly string[];
  /** The path of the file `text` is the content of, when the caller knows it: a .env* file or one under ~/.ssh is
   *  dropped whole. */
  readonly path?: string;
  /** Cut mode: asked of each restorable cut alone (label, personal, jev); true leaves its text in place, the cut still
   *  reported, `kept: true`. Never asked of a format, held or dump cut: those are always cut. */
  readonly keep?: (cut: Readonly<Cut>) => boolean;
};
export type ScrubCount = { counts: Record<string, number>; cuts: Cut[] };
export type ScrubResult = { ok: true; text: string; cuts: Cut[]; counts: Record<string, number> } | { ok: false; counts: Record<string, never> };

/** The longest text one pass reads, and the most time it may take between two rules: past either, the pass throws (cut
 *  mode then fails closed). Every rule is linear, so neither is met in good faith. */
export const SCRUB_MAX_CHARS = 32 * 1024 * 1024;
export const SCRUB_BUDGET_MS = 30_000;

/** Which kind wins a tie on restorability and length: the one that drops the most. */
const KIND_RANK: Readonly<Record<CutKind, number>> = { dump: 0, format: 1, held: 2, label: 3, personal: 4, jev: 5 };

/** A cut's text in the output: a value's `[redacted:<rule>]`, a dump's `[redacted:<rule> N lines]`. */
const marker = (cut: Pick<Cut, "rule" | "kind">, value: string): string => {
  if (cut.kind !== "dump") return `[redacted:${cut.rule}]`;
  return `[redacted:${cut.rule} ${lineCount(value)} lines]`;
};
const MARKER = /\[redacted:[a-z0-9-]{1,64}(?: \d{1,9} lines)?\]/g;

/** Every rule's hits in `text`, resolved to cuts: hits that overlap are one cut over all of them, named for the strongest
 *  (not restorable before restorable, then the longest, then KIND_RANK, then the table's order), so a cut a preview may
 *  restore never holds a value a rule marked not restorable. */
async function cutsOf(rules: readonly ScrubRule[], text: string, ctx: ScrubContext): Promise<Cut[]> {
  if (text.length > SCRUB_MAX_CHARS) throw new Error("scrub: text too long");
  const began = performance.now();
  const hits: { hit: Hit; rule: ScrubRule; order: number }[] = [];
  for (const [order, rule] of rules.entries()) {
    if (!Object.hasOwn(RESTORABLE, rule.kind)) throw new Error(`scrub: rule ${rule.id} has no kind`);
    for (const hit of await rule.find(text, ctx)) {
      if (!Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end > text.length || hit.end < hit.start) throw new Error(`scrub: rule ${rule.id} gave a span outside the text`);
      if (hit.end > hit.start) hits.push({ hit, rule, order });
    }
    if (performance.now() - began > SCRUB_BUDGET_MS) throw new Error("scrub: over its time budget");
  }
  hits.sort((a, b) => a.hit.start - b.hit.start || b.hit.end - a.hit.end);
  const stronger = (a: (typeof hits)[number], b: (typeof hits)[number]): boolean => {
    const restorable = Number(RESTORABLE[a.rule.kind]) - Number(RESTORABLE[b.rule.kind]);
    if (restorable) return restorable < 0;
    const length = a.hit.end - a.hit.start - (b.hit.end - b.hit.start);
    if (length) return length > 0;
    const rank = KIND_RANK[a.rule.kind] - KIND_RANK[b.rule.kind];
    return rank ? rank < 0 : a.order < b.order;
  };
  const cuts: Cut[] = [];
  for (let at = 0; at < hits.length; ) {
    let best = hits[at]!;
    let end = best.hit.end;
    let next = at + 1;
    for (; next < hits.length && hits[next]!.hit.start < end; next++) {
      const hit = hits[next]!;
      end = Math.max(end, hit.hit.end);
      if (stronger(hit, best)) best = hit;
    }
    const start = hits[at]!.hit.start;
    const { rule } = best;
    cuts.push({ rule: rule.id, kind: rule.kind, restorable: RESTORABLE[rule.kind], start, end, shape: shapeOf(rule, text.slice(start, end)) });
    at = next;
  }
  return cuts;
}

const countsOf = (cuts: readonly Cut[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const cut of cuts) counts[cut.rule] = (counts[cut.rule] ?? 0) + 1;
  return counts;
};

/** `scrub` over `rules` in place of SCRUB_RULES: the engine, for a test that injects a rule. */
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions & { mode: "count" }): Promise<ScrubCount>;
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions & { mode: "cut" }): Promise<ScrubResult>;
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions): Promise<ScrubCount | ScrubResult>;
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions): Promise<ScrubCount | ScrubResult> {
  if (opts.mode === "count") {
    // A throw here rejects: a scorer must never read an error as zero cuts.
    const cuts = await cutsOf(rules, text, contextOf(text, opts));
    return { counts: countsOf(cuts), cuts };
  }
  try {
    const ctx = contextOf(text, opts);
    const cuts = await cutsOf(rules, text, ctx);
    let out = "";
    let from = 0;
    const made: Cut[] = [];
    for (const cut of cuts) {
      const value = text.slice(cut.start, cut.end);
      // RESTORABLE, never the cut's own field, decides whether `keep` is asked at all.
      const kept = RESTORABLE[cut.kind] && opts.keep !== undefined && opts.keep(Object.freeze({ ...cut })) === true;
      out += text.slice(from, cut.start);
      const outStart = out.length;
      out += kept ? value : marker(cut, value);
      made.push({ ...cut, outStart, outEnd: out.length, ...(kept ? { kept: true as const } : {}) });
      from = cut.end;
    }
    out += text.slice(from);
    await assertClean(rules, out, ctx);
    return { ok: true, text: out, cuts: made, counts: countsOf(made) };
  } catch {
    // Fails closed: whatever threw, no text, no cut, no count leaves.
    return { ok: false, counts: {} };
  }
}

/** Cut `text` of every rule's finds ("cut": the text, its cuts and counts; on ANY error `{ok:false}` and no text), or
 *  count them ("count": counts and cuts, never text). Async: secretlint's pass is. */
export function scrub(text: string, opts: ScrubOptions & { mode: "count" }): Promise<ScrubCount>;
export function scrub(text: string, opts: ScrubOptions & { mode: "cut" }): Promise<ScrubResult>;
export function scrub(text: string, opts: ScrubOptions): Promise<ScrubCount | ScrubResult>;
export function scrub(text: string, opts: ScrubOptions): Promise<ScrubCount | ScrubResult> {
  return scrubWith(SCRUB_RULES, text, opts);
}

function contextOf(text: string, opts: ScrubOptions): ScrubContext {
  const held = [...new Set((opts.held ?? []).filter((value) => value.replace(/\s+/g, "").length >= MIN_SECRET))];
  let lint: Promise<string[]> | undefined;
  return { held, path: opts.path, lint: () => (lint ??= secretsIn(text)) };
}

/** What a cut text must not hold: a known format the rules still find (each cut read as a blank, so a cut's own marker
 *  is never one), or a held value in a form no rule cut in place (split by whitespace, partly encoded: valueMatcher's
 *  views, each cut read as a character no form holds). Either throws, and cut mode fails closed. */
async function assertClean(rules: readonly ScrubRule[], out: string, ctx: ScrubContext): Promise<void> {
  const blanked = out.replace(MARKER, " ");
  const again: ScrubContext = { held: [], lint: async () => [] };
  for (const rule of rules) {
    if (rule.kind === "format" && (await rule.find(blanked, again)).some((hit) => hit.end > hit.start)) throw new Error(`scrub: ${rule.id} still finds a value`);
  }
  if (ctx.held.length && valueMatcher(ctx.held)(out.replace(MARKER, "\u0000"))) throw new Error("scrub: a held value is left");
}
