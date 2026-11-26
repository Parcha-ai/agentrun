// The values of an environment's key-shaped variables, cut out of text this server keeps: the rule of the harness log's
// cut, for what the importer writes (a transcript can hold a key a tool printed or was given). The import adds the keys
// secretlint finds in what it reads (`secretsIn`): keys of a known format, whoever's they are.
import { lintSource } from "@secretlint/core";
// The recommended preset's rules, built into core since secretlint v14 (the preset's own package is deprecated).
import { recommendedRules as recommended } from "@secretlint/core/builtin";
import { secretLintProfiler } from "@secretlint/profiler";

// No performance marks: the profiler would leave about 14 a call in the process's global buffer.
secretLintProfiler.setEnabled(false);

import { keyShaped } from "./secret-name.js";
import { secretValues } from "./api-token.js";
import { MIN_SECRET, valueMatcher } from "./learn/secrets.js";
import { SEPARATOR } from "./redact/match.js";
import { userInfo } from "node:os";
import { type CommandFacts, commandFacts, type Cut, type CutKind, decodedTimes, type Hit, inputSpan, isPlaceholder, KEY_RUN_MAX, lineBounds, lineCount, type LintFind, RESTORABLE, SCRUB_RULES, type ScrubContext, type ScrubRule, shapeOf, type View, viewsOf } from "./secret-rules.js";

export { type Cut, type CutKind, isPlaceholder, RESTORABLE, RULE_PATTERNS, SCRUB_RULES, type ScrubRule, viewsOf } from "./secret-rules.js";

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
 *  repository's own config a tool printed, a web page) would switch every rule off for the rest of it. The rule ids are
 *  pinned by test (secretlint-deps.test.mjs), so a bump that empties or changes the set is read before it ships. There is
 *  no load-time check of its own: the exact @secretlint/core pin and that test stand for it. A consumer that forces
 *  another core through npm overrides is outside both, and could load no rules and cut nothing. */
const FILTER_COMMENTS = "@secretlint/secretlint-rule-filter-comments";
const SECRETLINT = { rules: recommended.filter((rule) => rule.meta.id !== FILTER_COMMENTS).map((rule) => ({ id: rule.meta.id, rule })) };
/** The ids of the rules the scan runs, in order. Only the ids are exported: the rules' own types come from a secretlint
 *  types package that serve doesn't depend on. */
export const SECRETLINT_RULE_IDS: readonly string[] = SECRETLINT.rules.map((rule) => rule.id);
/** How many passes `secretsIn` has made in this process: for a test that a path makes none. */
export const secretlintCalls = { count: 0 };

/** The keys secretlint's recommended rules find in `content`, in one pass: each as the rule names it (the secret
 *  itself where the rule gives it, else what it matched), and as a JSON string holding it would read it, decoded up to
 *  three times, so the cut finds it in a record's parsed text and in a shell's output kept in one as JSON. */
export async function secretsIn(content: string): Promise<string[]> {
  return [...new Set((await lintFinds(content)).map((find) => find.value))];
}

/** secretsIn's finds, each with the message secretlint reported it under (what anchors it: the scrubber's rules read a
 *  label-anchored message apart from a format's). */
export async function lintFinds(content: string): Promise<LintFind[]> {
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
  const found = new Map<string, LintFind>();
  for (const message of messages) {
    const id = message.messageId ?? message.ruleId;
    const named = Object.values(message.data ?? {}).filter((value): value is string => typeof value === "string" && value.length >= 8 && content.includes(value));
    for (const each of named.length ? named : [content.slice(message.range[0], message.range[1])]) {
      let value: string | undefined = each;
      for (let level = 0; value !== undefined && level < 3; level++) {
        if (!found.has(`${id}\u0000${value}`)) found.set(`${id}\u0000${value}`, { id, value });
        value = decoded(value);
      }
    }
  }
  return [...found.values()];
}

// ---------- the scrubber (Scrubber beta 1; the interface: tl-share's CONTRACT-scrub-beta1.md)

export type ScrubOptions = {
  readonly mode: "count" | "cut";
  /** Values the server holds (serverSecrets, handed refs, env key-shaped values): each cut in every form it stands in. */
  readonly held?: readonly string[];
  /** The path of the file `text` is the content of, when the caller knows it: a .env* file, one under ~/.ssh or a
   *  credentials file is dropped whole. */
  readonly path?: string;
  /** The shell command whose output `text` is, when the caller knows it (a tool call's, ruling LVI): a command that reads
   *  one file alone (`cat ~/.pgpass`) gives `path` when none is given, and an env command's output is a dump. */
  readonly command?: string;
  /** `text` is lines flattened onto one, every run of blanks made a space (a run's title: runs-over-store.ts
   *  prepareLaunch): a prompt inside the line opens a command as a line's start would, and an env command's output
   *  runs on after it to the next prompt (env-dump). */
  readonly flattened?: boolean;
  /** `command`'s facts, made once with commandFacts(command) by a caller that scrubs one call's output string by string
   *  (run-export.ts, share-host.ts), so the command is read once for them all. They stand for `command`: given both, the
   *  facts' command is the one read. Given `command` alone, a scrub makes them once for every view of its text. */
  readonly commandFacts?: CommandFacts;
  /** The homes the caller holds (rulings E, VII): a bare `/home/<user>` with no segment after it, or a Claude project
   *  folder's `-home-<user>-` outside `.claude/projects/`, is cut only for one of these. When not given, this process's
   *  user's home and $HOME. */
  readonly homes?: readonly string[];
  /** Cut mode: asked of each restorable cut alone (label, personal, jev); true leaves its text in place, the cut still
   *  reported, `kept: true`. Never asked of a format, held or dump cut: those are always cut. */
  readonly keep?: (cut: Readonly<Cut>) => boolean;
};
/** Count mode's answer: the cuts, and `blocked`, whether cut mode would fail closed on the same text (its final check
 *  finds a held value or a format left in the cut text): a share of it would be refused. */
export type ScrubCount = { counts: Record<string, number>; cuts: Cut[]; blocked: boolean };
export type ScrubResult = { ok: true; text: string; cuts: Cut[]; counts: Record<string, number> } | { ok: false; counts: Record<string, never> };
/** The engine's limits, for a test: the chunk length and the overlap between chunks, the time budget and its clock. */
export type ScrubLimits = { readonly maxChars?: number; readonly overlap?: number; readonly budgetMs?: number; readonly now?: () => number };

/** The longest piece of a text one pass reads: a longer text is read in pieces this long, each overlapping the next by
 *  SCRUB_OVERLAP (more than any rule's longest match), so a value across a piece's end is read whole in the next one.
 *  Never truncated, never skipped (ruling B). */
export const SCRUB_MAX_CHARS = 32 * 1024 * 1024;
export const SCRUB_OVERLAP = 1024 * 1024;
/** The most time a scrub may take, its final check included: past it, the scrub throws (cut mode fails closed, count
 *  mode rejects). Every rule is linear, so it is not met in good faith. */
export const SCRUB_BUDGET_MS = 30_000;

/** Which hit names a cut where hits overlap (ruling C): the kind that drops the most and may not be restored first,
 *  then the longest, then the deeper view, then the table's order. */
const KIND_RANK: Readonly<Record<CutKind, number>> = { held: 0, format: 1, dump: 2, label: 3, personal: 4, jev: 5 };

/** A cut's text in the output: its rule's replacement (a home folder's `~`), a value's `[redacted:<rule>]`, a dump's
 *  `[redacted:<rule> N lines]`, N counted in the view that found it (a JSON string's escaped line breaks are lines). */
const marker = (rule: ScrubRule, value: string): string => {
  if (rule.replacement !== undefined) return rule.replacement;
  if (rule.kind !== "dump") return `[redacted:${rule.id}]`;
  return `[redacted:${rule.id} ${lineCount(value)} lines]`;
};
const MARKER = /\[redacted:[a-z0-9-]{1,64}(?: \d{1,9} lines)?\]/g;
const QUOTES = "\"'";

/** The clock and the deadline a scrub reads, and the chunks it reads a text in. */
type Run = { readonly maxChars: number; readonly overlap: number; readonly deadline: number; readonly now: () => number };
const runOf = (limits: ScrubLimits): Run => {
  const now = limits.now ?? (() => performance.now());
  const maxChars = limits.maxChars ?? SCRUB_MAX_CHARS;
  const overlap = Math.min(limits.overlap ?? SCRUB_OVERLAP, Math.floor(maxChars / 2));
  // A chunk's overlap holds a key's longest run (ruling XXXIII), so a key that straddles a bound is whole in one chunk;
  // a chunk too short for that (a test's 4096) holds no such run anyway.
  if (maxChars >= 2 * KEY_RUN_MAX && overlap < KEY_RUN_MAX) throw new Error(`scrub: overlap ${overlap} is below KEY_RUN_MAX ${KEY_RUN_MAX}`);
  return { maxChars, overlap, deadline: now() + (limits.budgetMs ?? SCRUB_BUDGET_MS), now };
};
const inTime = (run: Run): void => {
  if (run.now() > run.deadline) throw new Error("scrub: over its time budget");
};
/** The [start, end) of each chunk of `text`: one chunk when it fits, else maxChars long each, each starting `overlap`
 *  before the last one's end; a bound that falls inside a JSON escape moves to the escape's start, so no chunk starts
 *  or ends inside one (ruling XV). */
function chunksOf(text: string, run: Run): [number, number][] {
  const length = text.length;
  if (length <= run.maxChars) return [[0, length]];
  const out: [number, number][] = [];
  for (let start = 0; ; start += run.maxChars - run.overlap) {
    const end = Math.min(length, start + run.maxChars);
    out.push([escapeStartAt(text, start), escapeStartAt(text, end)]);
    if (end === length) return out;
  }
}

const ESCAPE_LETTERS = "\"\\/bfnrt";
const HEX4 = /^[0-9A-Fa-f]{4}$/;
/** `at`, or the start of the JSON escape `at` falls strictly inside (`\n`, `\uXXXX`), read as a JSON string reads it:
 *  a backslash opens an escape when an even number of backslashes stand right before it. */
function escapeStartAt(text: string, at: number): number {
  for (let from = at - 1; from >= 0 && from >= at - 5; from--) {
    if (text.charCodeAt(from) !== 92) continue;
    let before = 0;
    while (from - before - 1 >= 0 && text.charCodeAt(from - before - 1) === 92) before++;
    if (before % 2) continue;
    const letter = text.charAt(from + 1);
    const end = ESCAPE_LETTERS.includes(letter) && letter !== "" ? from + 2 : letter === "u" && HEX4.test(text.slice(from + 2, from + 6)) ? from + 6 : from + 1;
    return from < at && at < end ? from : at;
  }
  return at;
}

type Found = { start: number; end: number; rule: ScrubRule; order: number; depth: number };

/** The closing quote of the innermost string (of `lists`, each sorted and disjoint) that holds `at`, or Infinity. */
function stringEnd(lists: readonly (readonly (readonly [number, number])[])[], at: number): number {
  let end = Number.POSITIVE_INFINITY;
  for (const spans of lists) {
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (spans[mid]![0] < at) low = mid + 1;
      else high = mid;
    }
    const span = spans[low - 1];
    if (span && span[1] >= at) end = Math.min(end, span[1]);
  }
  return end;
}

/** Every rule's hits in one view of a chunk, mapped to the input (`offset`: the chunk's start in it), each widened to
 *  hold an escape it starts or ends inside. A label rule's hit on a placeholder (isPlaceholder) is no hit, whichever
 *  label rule found it. */
async function viewHits(rules: readonly ScrubRule[], view: View, offset: number, opts: ScrubOptions, run: Run, out: Found[]): Promise<void> {
  const ctx = contextOf(view, opts);
  for (const [order, rule] of rules.entries()) {
    if (!Object.hasOwn(RESTORABLE, rule.kind)) throw new Error(`scrub: rule ${rule.id} has no kind`);
    for (const hit of await rule.find(view.text, ctx)) {
      if (!Number.isInteger(hit.start) || !Number.isInteger(hit.end) || hit.start < 0 || hit.end > view.text.length || hit.end < hit.start) throw new Error(`scrub: rule ${rule.id} gave a span outside the text`);
      if (hit.end === hit.start) continue;
      if (rule.kind === "label") {
        // What follows the value is read on its own line or in its own string only (ruling LIV, XLVI's bound): a JSON
        // string's end and its object's `}` or `,` after it are no code's evidence for the value.
        const slot = { name: hit.name, bare: hit.quoted !== true && !QUOTES.includes(view.source.charAt(hit.start - 1) || " "), after: view.text.slice(hit.end, Math.min(hit.end + 8, ctx.lines?.end(hit.end) ?? view.text.length)), code: hit.code, typed: hit.typed };
        if (isPlaceholder(view.text.slice(hit.start, hit.end), slot)) continue;
      }
      const [start, end] = inputSpan(view, hit.start, hit.end);
      if (end > start) out.push({ start: offset + start, end: offset + end, rule, order, depth: view.depth });
    }
    inTime(run);
  }
}

/** Every rule's hits in every view of every chunk of `text` (ruling A: the union), resolved to cuts: hits that overlap
 *  are one cut over all of them, named for the strongest (ruling C: KIND_RANK, then the longest in the input, then the
 *  deeper view, then the table's order). Each cut's offsets are the input's; its shape and its marker are read from its
 *  text decoded as often as the view that named it was. */
async function cutsOf(rules: readonly ScrubRule[], text: string, opts: ScrubOptions, run: Run): Promise<{ cut: Cut; marker: string }[]> {
  const hits: Found[] = [];
  for (const [from, to] of chunksOf(text, run)) {
    const found = hits.length;
    const views = viewsOf(text.slice(from, to));
    for (const view of views) await viewHits(rules, view, from, opts, run, hits);
    // A hit that starts inside a JSON string ends by its closing quote at the latest (ruling XLIX): a string any view
    // reads, in the input's offsets (a decoded string's quote is its escape there, `\"`), so a cut never eats a
    // string's end and the output still parses.
    const strings = views.map((view) => view.strings.map(([open, close]) => [from + view.at(open), from + view.at(close)] as const));
    for (let at = found; at < hits.length; at++) {
      const hit = hits[at]!;
      hit.end = Math.min(hit.end, stringEnd(strings, hit.start));
      if (hit.end <= hit.start) hits.splice(at--, 1);
    }
    // A hit widened past its chunk's bounds read an escape the chunk split: fails closed (ruling XV).
    for (let at = found; at < hits.length; at++) if (hits[at]!.start < from || hits[at]!.end > to) throw new Error("scrub: a cut crosses its chunk's bounds");
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const stronger = (a: Found, b: Found): boolean => {
    const rank = KIND_RANK[a.rule.kind] - KIND_RANK[b.rule.kind];
    if (rank) return rank < 0;
    const length = a.end - a.start - (b.end - b.start);
    if (length) return length > 0;
    if (a.depth !== b.depth) return a.depth > b.depth;
    return a.order < b.order;
  };
  const cuts: { cut: Cut; marker: string }[] = [];
  for (let at = 0; at < hits.length; ) {
    let best = hits[at]!;
    const start = best.start;
    let end = best.end;
    let next = at + 1;
    for (; next < hits.length && hits[next]!.start < end; next++) {
      const hit = hits[next]!;
      end = Math.max(end, hit.end);
      if (stronger(hit, best)) best = hit;
    }
    const { rule } = best;
    const value = decodedTimes(text.slice(start, end), best.depth);
    cuts.push({ cut: { rule: rule.id, kind: rule.kind, restorable: RESTORABLE[rule.kind], start, end, shape: shapeOf(rule, value) }, marker: marker(rule, value) });
    at = next;
  }
  return cuts;
}

const countsOf = (cuts: readonly Cut[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const cut of cuts) counts[cut.rule] = (counts[cut.rule] ?? 0) + 1;
  return counts;
};

/** The text with each cut's marker in its place, or its own text where `keep` (cut mode alone) leaves it. */
function cutText(text: string, cuts: readonly { cut: Cut; marker: string }[], keep: ScrubOptions["keep"]): { out: string; made: Cut[] } {
  const parts: string[] = [];
  let length = 0;
  let from = 0;
  const made: Cut[] = [];
  for (const { cut, marker } of cuts) {
    const value = text.slice(cut.start, cut.end);
    // RESTORABLE, never the cut's own field, decides whether `keep` is asked at all.
    const kept = RESTORABLE[cut.kind] && keep !== undefined && keep(Object.freeze({ ...cut })) === true;
    const before = text.slice(from, cut.start);
    const put = kept ? value : marker;
    parts.push(before, put);
    const outStart = length + before.length;
    length = outStart + put.length;
    made.push({ ...cut, outStart, outEnd: length, ...(kept ? { kept: true as const } : {}) });
    from = cut.end;
  }
  parts.push(text.slice(from));
  return { out: parts.join(""), made };
}

/** `scrub` over `rules` in place of SCRUB_RULES: the engine, for a test that injects a rule (and its limits). */
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions & { mode: "count" }, limits?: ScrubLimits): Promise<ScrubCount>;
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions & { mode: "cut" }, limits?: ScrubLimits): Promise<ScrubResult>;
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions, limits?: ScrubLimits): Promise<ScrubCount | ScrubResult>;
export async function scrubWith(rules: readonly ScrubRule[], text: string, opts: ScrubOptions, limits: ScrubLimits = {}): Promise<ScrubCount | ScrubResult> {
  // A command is read into its facts once for the whole scrub (every chunk and view), unless the caller made them.
  if (opts.commandFacts === undefined && opts.command !== undefined) opts = { ...opts, commandFacts: commandFacts(opts.command) };
  if (opts.mode === "count") {
    // A throw here rejects: a scorer must never read an error as zero cuts. The same output cut mode makes (no keep)
    // and the same final check say whether cut mode would fail closed.
    const run = runOf(limits);
    const cuts = await cutsOf(rules, text, opts, run);
    const blocked = !(await clean(rules, cutText(text, cuts, undefined).out, opts, run));
    const made = cuts.map(({ cut }) => cut);
    return { counts: countsOf(made), cuts: made, blocked };
  }
  try {
    const run = runOf(limits);
    const { out, made } = cutText(text, await cutsOf(rules, text, opts, run), opts.keep);
    if (!(await clean(rules, out, opts, run))) throw new Error("scrub: the cut text is not clean");
    return { ok: true, text: out, cuts: made, counts: countsOf(made) };
  } catch {
    // Fails closed: whatever threw, no text, no cut, no count leaves.
    return { ok: false, counts: {} };
  }
}

/** Cut `text` of every rule's finds ("cut": the text, its cuts and counts; on ANY error `{ok:false}` and no text), or
 *  count them ("count": counts, cuts and whether a cut would be refused, never text). Async: secretlint's pass is. */
export function scrub(text: string, opts: ScrubOptions & { mode: "count" }): Promise<ScrubCount>;
export function scrub(text: string, opts: ScrubOptions & { mode: "cut" }): Promise<ScrubResult>;
export function scrub(text: string, opts: ScrubOptions): Promise<ScrubCount | ScrubResult>;
export function scrub(text: string, opts: ScrubOptions): Promise<ScrubCount | ScrubResult> {
  return scrubWith(SCRUB_RULES, text, opts);
}

const WHITESPACE = /\s/g;
const heldOf = (opts: ScrubOptions): string[] => [...new Set((opts.held ?? []).filter((value) => value.replace(WHITESPACE, "").length >= MIN_SECRET))];

/** This process's home folders: its user's (the password database's) and $HOME. */
export function processHomes(): string[] {
  const homes = new Set<string>();
  try {
    homes.add(userInfo().homedir);
  } catch {
    // No user entry (a container's uid with none): $HOME alone.
  }
  if (process.env.HOME) homes.add(process.env.HOME);
  return [...homes].filter((home) => home.length > 1);
}

/** What the rules read beside a view: the held values, the view's unblanked text, the homes, the path and the command, and secretlint's
 *  finds in the view (one pass a view, on first ask). */
function contextOf(view: View, opts: ScrubOptions): ScrubContext {
  let lint: Promise<LintFind[]> | undefined;
  return { held: heldOf(opts), source: view.source, homes: opts.homes ?? processHomes(), path: opts.path ?? opts.commandFacts?.readPath, facts: opts.commandFacts, flattened: opts.flattened === true, lint: () => (lint ??= lintFinds(view.text)), lines: lineBounds(view.text, ...view.decodedStrings, view.strings) };
}

/** Whether a cut text holds nothing the scrub must cut: no known format the format rules still find in any view of any
 *  chunk of it (each marker read as a blank, so a marker is never one), and no held value in any form (valueMatcher:
 *  split by whitespace, partly encoded) in the text as written or in any decoding of it, each marker read as a
 *  character no form holds and every view keeps (SEPARATOR, read with valueMatcher's `separated`: a NUL would not do,
 *  as the views drop control characters). A U+FFFF the text brought is read as a NUL first, nothing to the views, so
 *  only a marker separates. The time budget holds here too (a throw). */
async function clean(rules: readonly ScrubRule[], out: string, opts: ScrubOptions, run: Run): Promise<boolean> {
  const blanked = out.replace(MARKER, (found) => " ".repeat(found.length));
  const formats = rules.filter((rule) => rule.kind === "format");
  for (const [from, to] of chunksOf(blanked, run)) {
    for (const view of viewsOf(blanked.slice(from, to))) {
      const again: ScrubContext = { held: [], source: view.source, homes: [], lint: async () => [], lines: lineBounds(view.text, ...view.decodedStrings, view.strings) };
      for (const rule of formats) {
        if ((await rule.find(view.text, again)).some((hit) => hit.end > hit.start)) return false;
        inTime(run);
      }
    }
  }
  const held = heldOf(opts);
  if (!held.length) return true;
  const matches = valueMatcher(held, { separated: true });
  for (const view of viewsOf(out)) {
    if (matches(view.source.replaceAll(SEPARATOR, "\u0000").replace(MARKER, SEPARATOR))) return false;
    inTime(run);
  }
  return true;
}
