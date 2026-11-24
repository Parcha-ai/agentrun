// `agentrun-serve scrub RUN [--data DIR] [--json]`: what a share of one run would cut, counted, read from the local store.
// It gathers the text a share carries (share-design §1: the run view's allowlisted fields, its served Timeline rows, a
// workflow's graph, its agent's name), each string as the server serves it (the run's one cut applied, run-cut.ts), and
// runs the scrubber over each in count mode with the run's cut set as its held values (secret-cut.ts scrub). It prints
// counts by rule and by kind, and how many of the cuts the person could restore. Never a value, a piece of one, a shape
// or an offset: counts only. It reads and changes nothing (the store opened as a runner opens it; no seal key made).
//
// Exit 0 once counted, 1 when the run is withheld (its cut can't be read here: a sign-in pointer or a sealed launch that
// doesn't open, or no seal key for a store that keeps secrets; it never counts without the held values), 2 for bad arguments or a run the
// store does not hold.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ApiError } from "./errors.js";
import { defaultData } from "./server-fs.js";
import { logLine } from "./print.js";
import { runCutValues } from "./run-cut.js";
import { runGraphView } from "./run-reads-over-store.js";
import { servedTimelineRows } from "./run-timeline-served.js";
import type { SignInReader } from "./run-view.js";
import { scrub } from "./secret-cut.js";
import { type CallContext, callContexts, effectContext, rowOutput } from "./share-context.js";
import { hostSecrets, handedSecret, type StoredKeys, withSecrets } from "./secrets.js";
import { bootSealKey, SealKeyRefused, withSealKey } from "./seal-key.js";
import { signInReads } from "./sign-ins-store.js";
import { factsOverStore, viewOverStore, type ViewDeps } from "./store-view.js";
import { openStore, SchemaVersionUnknown, type Store, storeTarget } from "./store/index.js";
import { STORE_FILE } from "./store/sqlite/store.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { toolKeysOverStore } from "./tool-keys-store.js";

/** The kinds of cut, in the order they are printed (secret-rules.ts CutKind). */
export const CUT_KINDS = ["format", "held", "dump", "label", "personal", "jev"] as const;
type Kind = (typeof CUT_KINDS)[number];

/** The run view's fields a share carries (share-design §1, the `run` allowlist, store-view.ts viewOfRun); every other
 *  field is dropped. `imported_from` carries its `source` alone. */
export const SHARE_RUN_FIELDS = ["kind", "status", "state", "title", "created_at", "ended_at", "result", "error", "review", "cost", "stopped_for", "budget_refused_calls", "effort", "approvals"] as const;

/** The reads a share's text is gathered by: the run's one cut (run-cut.ts runCutValues) and what serves under it. */
export interface ShareTextDeps {
  readonly serverSecrets: () => string[];
  readonly signIns?: SignInReader;
  /** The store's seal key, undefined when it has none: the run's sealed launch values are read under it (run-cut.ts). */
  readonly sealKey: Buffer | undefined;
  readonly keyEnv: () => NodeJS.ProcessEnv;
}

/** Every string in a JSON value, its object keys included (a key can hold a value: a header's name a tool printed, a
 *  map keyed by a command line). */
export function stringsOf(value: unknown): string[] {
  const out: string[] = [];
  const add = (each: unknown): void => {
    if (typeof each === "string") out.push(each);
    else if (Array.isArray(each)) for (const item of each) add(item);
    else if (each !== null && typeof each === "object") {
      for (const [key, item] of Object.entries(each)) {
        out.push(key);
        add(item);
      }
    }
  };
  add(value);
  return out;
}

/** A tool's output with its call's context (ruling LVI, share-context.ts CallContext): the file the call read whole
 *  (`path`) or the shell command it ran (`command`). A share's export reads the same (run-export.ts). */
export interface ShareText extends CallContext {
  readonly text: string;
}

/** A served Timeline row's strings, the one that holds a call's output (share-context.ts rowOutput: a result's preview, an
 *  approval outcome's text) with that call's context. */
function rowTexts(row: unknown, contexts: ReadonlyMap<string, CallContext>): (string | ShareText)[] {
  const output = rowOutput(row, contexts);
  if (output === undefined) return stringsOf(row);
  const fields = row as Record<string, unknown>;
  return [...stringsOf({ ...fields, [output.field]: null }), { text: fields[output.field] as string, ...output.context }];
}

/** A workflow graph's strings, each call's output (`effects[i].output`, every string in it) with that call's own context
 *  (share-context.ts effectContext). */
function graphTexts(graph: unknown): (string | ShareText)[] {
  if (graph === null || typeof graph !== "object" || !Array.isArray((graph as { effects?: unknown }).effects)) return stringsOf(graph);
  const texts: (string | ShareText)[] = stringsOf({ ...graph, effects: null });
  for (const effect of (graph as { effects: unknown[] }).effects) {
    const context = effectContext(effect);
    if (context === undefined) {
      texts.push(...stringsOf(effect));
      continue;
    }
    const { output, ...rest } = effect as Record<string, unknown>;
    texts.push(...stringsOf({ ...rest, output: null }), ...stringsOf(output).map((text) => ({ text, ...context })));
  }
  return texts;
}

/** What a share of a run carries as the count reads it, from what shareTexts read: the run view's allowlisted fields, the
 *  agent's name, the served rows (each call's output with its context, from the rows read with their calls' arguments,
 *  `calls`, which are read for that alone) and a workflow's graph (null for none). */
export function shareTextsOf(read: { view: Readonly<Record<string, unknown>>; agentName: unknown; rows: readonly unknown[]; calls: readonly unknown[]; graph: unknown }): (string | ShareText)[] {
  const texts: (string | ShareText)[] = [];
  const add = (value: unknown): void => void texts.push(...stringsOf(value));
  for (const field of SHARE_RUN_FIELDS) add(read.view[field]);
  add((read.view.imported_from as { source?: unknown } | undefined)?.source);
  add(read.agentName);
  const contexts = callContexts(read.calls);
  for (const row of read.rows) texts.push(...rowTexts(row, contexts));
  if (read.graph !== null) texts.push(...graphTexts(read.graph));
  return texts;
}

/** What a share of run `runId` would carry, as strings (object keys included: stringsOf), a tool's output with its
 *  call's context (ShareText), with the run's cut set read after them (the cut only grows, so the last read holds every
 *  value an earlier read cut); `unknown` for a run the store does not hold, `withheld` when its cut can't be read here. */
export async function shareTexts(store: Store, runId: string, deps: ShareTextDeps): Promise<{ kind: string; texts: (string | ShareText)[]; held: string[] } | "unknown" | "withheld"> {
  const row = await store.runs.get(runId).catch(() => undefined);
  if (!row) return "unknown";
  if ((await runCutValues(deps, store, runId)) === "unreadable") return "withheld";
  // The origin names the console's link, which the allowlist drops: none of it is read. A reserved .invalid name, so the
  // package scan finds no service endpoint.
  const viewDeps: ViewDeps = { origin: "http://scrub.invalid", serverSecrets: deps.serverSecrets, keyEnv: deps.keyEnv, sealKey: deps.sealKey, ...(deps.signIns ? { signIns: deps.signIns } : {}) };
  const view = await viewOverStore(store, runId, viewDeps);
  if (!view) return "unknown";
  const agentName = (await store.agents.get(row.agentId))?.name;
  // A result's output is scrubbed with its call's context (ruling LVI): the rows read with their calls' arguments name it.
  const calls = await servedTimelineRows(deps, store, runId, ctx, true);
  const rows = await servedTimelineRows(deps, store, runId, ctx, false);
  let graph: Record<string, unknown> | null = null;
  if (view.kind === "workflow") {
    try {
      graph = await runGraphView(store, runId, {
        runWorkspace: async () => null,
        recordings: async () => null,
        env: deps.keyEnv(),
        sealKey: deps.sealKey,
        runFacts: (_store, id) => factsOverStore(store, id, viewDeps),
        withheld: async () => false,
        cutValues: (_store, id) => runCutValues(deps, store, id),
        context: ctx,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "forbidden") return "withheld";
      throw error;
    }
  }
  const texts = shareTextsOf({ view, agentName, rows, calls, graph });
  const cut = await runCutValues(deps, store, runId);
  if (cut === "unreadable") return "withheld";
  return { kind: String(view.kind), texts, held: cut.values };
}

/** One rule's line of the count. */
export interface RuleCount {
  readonly rule: string;
  readonly kind: string;
  readonly restorable: boolean;
  readonly count: number;
}

/** The count `scrub` prints: by rule, by kind, the cuts a share would make and how many of them could be restored, and
 *  how many `[redacted]` marks the served text holds already (known key formats and held values the server's own cut takes
 *  out where it serves the run, run-view.ts shownOf, or keys an import took out before). */
export interface ShareCount {
  readonly run_id: string;
  readonly kind: string;
  readonly strings: number;
  readonly rules: RuleCount[];
  readonly by_kind: Record<Kind, number>;
  readonly cuts: number;
  readonly restorable: number;
  readonly already_redacted: number;
  /** Whether a share would be refused: cut mode fails closed on one of the strings (its final check finds a held value or
   *  a format left once cut), so no share of this run is made until a rule cuts it. */
  readonly blocked: boolean;
}

/** The scrubber's count over `texts` with `held` as its held values, a ShareText with its call's context: each cut's
 *  rule, kind and whether it can be restored, never its value, shape or offsets. */
export async function countCuts(runId: string, kind: string, texts: readonly (string | ShareText)[], held: readonly string[]): Promise<ShareCount> {
  const rules = new Map<string, { kind: string; restorable: boolean; count: number }>();
  let already = 0;
  let blocked = false;
  for (const each of texts) {
    const { text, path, command }: ShareText = typeof each === "string" ? { text: each } : each;
    already += text.split("[redacted]").length - 1;
    const counted = await scrub(text, { mode: "count", held, ...(path !== undefined ? { path } : {}), ...(command !== undefined ? { command } : {}) });
    blocked ||= counted.blocked;
    for (const cut of counted.cuts) {
      const line = rules.get(cut.rule) ?? { kind: cut.kind, restorable: cut.restorable, count: 0 };
      line.count += 1;
      rules.set(cut.rule, line);
    }
  }
  const lines = [...rules].map(([rule, line]) => ({ rule, ...line }));
  lines.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.rule.localeCompare(b.rule));
  const byKind = Object.fromEntries(CUT_KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  for (const line of lines) byKind[line.kind as Kind] = (byKind[line.kind as Kind] ?? 0) + line.count;
  const cuts = lines.reduce((n, line) => n + line.count, 0);
  const restorable = lines.filter((line) => line.restorable).reduce((n, line) => n + line.count, 0);
  return { run_id: runId, kind, strings: texts.length, rules: lines, by_kind: byKind, cuts, restorable, already_redacted: already, blocked };
}

const kindOrder = (kind: string): number => {
  const at = (CUT_KINDS as readonly string[]).indexOf(kind);
  return at === -1 ? CUT_KINDS.length : at;
};

/** The count as a table: one line per rule, totals by kind, and the line that says what a share would cut. */
export function countTable(count: ShareCount): string {
  const out: string[] = [`Run ${count.run_id} (${count.kind}): ${count.strings} strings a share would carry, counted.`, ""];
  const table = (head: string[], rows: string[][], right: number[]): void => {
    const widths = head.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i]!.length)));
    const line = (row: string[]) => row.map((cell, i) => (right.includes(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd();
    out.push(line(head), ...rows.map(line), "");
  };
  if (count.rules.length === 0) out.push("No rule matched.", "");
  else {
    table(["rule", "kind", "restorable", "count"], count.rules.map((r) => [r.rule, r.kind, r.restorable ? "yes" : "no", String(r.count)]), [3]);
    const kinds = Object.entries(count.by_kind).filter(([, n]) => n > 0);
    table(["kind", "count"], kinds.map(([k, n]) => [k, String(n)]), [1]);
  }
  if (count.already_redacted > 0) out.push(`Already cut before this count: ${count.already_redacted} ([redacted] in the served text: known key formats and held values the server cuts where it serves the run, or keys an import took out).`);
  out.push(`A share would make ${count.cuts} cut${count.cuts === 1 ? "" : "s"}; you could restore ${count.restorable} of them.`);
  if (count.blocked) out.push("But a share of this run would be refused: once cut, one of its strings still holds a held value or a known key format no rule cut in place.");
  return out.join("\n");
}

/** Every secret this server never shows that a command beside the store can read (the server's own serverSecrets, less
 *  what only its running process holds): the host's (its environment's key-named values, the launcher's), the keys a
 *  person saved (sealed tool keys), and the server's own and its trigger sources' sealed secrets. */
async function heldSecretsOf(store: Store, dir: string, env: NodeJS.ProcessEnv, sealed: boolean, say: (event: string) => (fields: Record<string, string>) => void): Promise<{ serverSecrets: () => string[]; stored: StoredKeys }> {
  if (!sealed) return { serverSecrets: () => hostSecrets(env), stored: () => undefined };
  const keys = toolKeysOverStore(store, env, say("tool_keys"));
  await keys.load();
  const stored: StoredKeys = (name) => keys.value(name);
  // import.ts ownSecrets: the server's API token and session secret (files beside the store), its webhook's signing
  // secret and each trigger source's sealed settings.
  const { ownSecrets } = await import("./import.js");
  const own = await ownSecrets(store, dir, env, say("sealed_settings"));
  return { serverSecrets: () => [...hostSecrets(env, stored), ...own], stored };
}

/** The line that says a run could not be counted: the error's own words, cut by the scrubber first with `held` as its
 *  held values (a store's error could quote what it read, a held value among it), else withheld. */
export async function couldNotCount(runId: string, error: unknown, held: readonly string[]): Promise<string> {
  const said = await scrub(error instanceof Error ? error.message : String(error), { mode: "cut", held });
  return `agentrun-serve scrub: run ${runId} could not be counted: ${said.ok ? said.text : "the reason is withheld"}. Nothing was counted.`;
}

/** `agentrun-serve scrub RUN [--data DIR] [--json]`: the exit code (the file's head). Output goes to `out`, words about
 *  why nothing was counted to `err`. */
export async function scrubMain(argv: readonly string[], usage: string, io: { out: (line: string) => void; err: (line: string) => void } = { out: console.log, err: console.error }): Promise<number> {
  let values: { data?: string | undefined; json?: boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { data: { type: "string" }, json: { type: "boolean" } } }));
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  if (positionals.length !== 1) {
    io.err(`scrub takes one run id\n\n${usage}`);
    return 2;
  }
  const runId = positionals[0]!;
  const dir = values.data ?? defaultData();
  const unknown = () => (io.err(`agentrun-serve scrub: there is no run ${runId} in ${dir}.`), 2);
  if (storeTarget(dir).kind === "sqlite" && !existsSync(join(dir, STORE_FILE))) return unknown();
  let store: Store;
  try {
    // Opened as a runner opens it: no owner lock (a running server keeps serving), no schema made, nothing written.
    store = await openStore({ dataDir: dir, role: "runner" });
  } catch (error) {
    if (error instanceof SchemaVersionUnknown && error.found === null) return unknown();
    throw error;
  }
  const warnings: string[] = [];
  const say = (event: string) => (fields: Record<string, string>) => void warnings.push(`agentrun-serve scrub: ${logLine(event, fields)}`);
  let release = (): void => undefined;
  // The held values read so far, for the error path's cut (couldNotCount).
  const held: string[] = [];
  try {
    // The seal key as the import boots it (seal-key.ts): handed, else the data directory's; a dry boot makes none. A
    // store that keeps secrets and has no key here refuses: its held values can't be read, so nothing is counted.
    let env = withSecrets(process.env);
    let seal;
    try {
      seal = await bootSealKey(store, dir, { given: handedSecret(SEAL_KEY_ENV), role: "import", write: false, say: (line) => void warnings.push(line.trimEnd()) });
    } catch (error) {
      if (!(error instanceof SealKeyRefused)) throw error;
      io.err(`agentrun-serve scrub: run ${runId} is withheld here: ${error.message} Without the run's held values nothing was counted.`);
      return 1;
    }
    if (seal) {
      release = seal.release;
      env = withSealKey(env, seal.text);
    }
    const { serverSecrets, stored } = await heldSecretsOf(store, dir, env, seal !== undefined, say);
    held.push(...serverSecrets());
    const deps: ShareTextDeps = {
      serverSecrets,
      ...(seal ? { signIns: signInReads(store, seal.key) } : {}),
      sealKey: seal?.key,
      keyEnv: () => withSecrets(env, "all", stored),
    };
    const gathered = await shareTexts(store, runId, deps);
    for (const line of warnings.splice(0)) io.err(line);
    if (gathered === "unknown") return unknown();
    if (gathered === "withheld") {
      io.err(`agentrun-serve scrub: run ${runId} is withheld: this server can't read back what it was handed, a browser sign-in or the keys sealed with its launch (its seal key changed or is missing, or the record is damaged), so its held values are unknown and nothing was counted.`);
      return 1;
    }
    held.push(...gathered.held);
    const count = await countCuts(runId, gathered.kind, gathered.texts, gathered.held);
    io.out(values.json ? JSON.stringify(count, null, 2) : countTable(count));
    return 0;
  } catch (error) {
    // A read or the scrubber failed: said in its own words, those words cut by the scrubber first (a store's error could
    // quote what it read), and never a partial count.
    io.err(await couldNotCount(runId, error, held));
    return 1;
  } finally {
    for (const line of warnings) io.err(line);
    release();
    await store.close();
  }
}
