// `agentrun-serve scrub RUN [--data DIR] [--json]`: what a share of one run would cut, counted, read from the local store.
// It makes the bundle a share's export makes (run-export.ts runExport, over the same store reads as the export route:
// run-export-store.ts), its files read from the run's folder under the data directory, and counts that bundle's cuts by
// rule and by kind, with how many the person could restore. The count is the export's own: what it names is what a
// share would cut. Never a value, a piece of one, a shape or an offset: counts only. It reads and changes nothing (the
// store opened as a runner opens it; no seal key made).
//
// Exit 0 once counted (a share that would fail closed is counted as blocked), 1 when the run is withheld (its cut can't
// be read here: a sign-in pointer or a sealed launch that doesn't open, or no seal key for a store that keeps secrets; it
// never counts without the held values) or has not ended, 2 for bad arguments or a run the store does not hold.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ApiError } from "./errors.js";
import { defaultData } from "./server-fs.js";
import { logLine } from "./print.js";
import { runCutValues } from "./run-cut.js";
import { ExportFailed, type ExportReads, runExport } from "./run-export.js";
import { exportReadsOverStore } from "./run-export-store.js";
import type { RunReadsDeps } from "./run-reads-over-store.js";
import type { SignInReader } from "./run-view.js";
import { scrub } from "./secret-cut.js";
import { hostSecrets, handedSecret, type StoredKeys, withSecrets } from "./secrets.js";
import { bootSealKey, SealKeyRefused, withSealKey } from "./seal-key.js";
import { signInReads } from "./sign-ins-store.js";
import { factsOverStore, type ViewDeps, withheldOverStore } from "./store-view.js";
import { openStore, SchemaVersionUnknown, type Store, storeTarget } from "./store/index.js";
import { STORE_FILE } from "./store/sqlite/store.js";
import { SEAL_KEY_ENV } from "./tool-keys.js";
import { toolKeysOverStore } from "./tool-keys-store.js";
import { serverRunWorkspace } from "./workspace/index.js";

/** The kinds of cut, in the order they are printed (secret-rules.ts CutKind). */
export const CUT_KINDS = ["format", "held", "dump", "label", "personal", "jev"] as const;
type Kind = (typeof CUT_KINDS)[number];


/** The reads a share's count is made by: the run's one cut (run-cut.ts runCutValues) and what serves under it, and the
 *  data directory its run folders are under (its files are read there, as the server reads them). */
export interface ShareTextDeps {
  readonly serverSecrets: () => string[];
  readonly signIns?: SignInReader;
  /** The store's seal key, undefined when it has none: the run's sealed launch values are read under it (run-cut.ts). */
  readonly sealKey: Buffer | undefined;
  readonly keyEnv: () => NodeJS.ProcessEnv;
  /** The server's data directory: a run's files are read from its folder there. Without it no file is read, and the count
   *  says so (`files_read: false`). */
  readonly data?: string;
}

/** One rule's line of the count. */
export interface RuleCount {
  readonly rule: string;
  readonly kind: string;
  readonly restorable: boolean;
  readonly count: number;
}

/** The count `scrub` prints, of the bundle a share's export makes (run-export.ts runExport): by rule, by kind, the cuts it
 *  holds and how many of them could be restored, the strings and files it carries, and how many `[redacted]` marks its
 *  text holds already (key formats and held values the server's own cut takes out where it serves the run, or keys an
 *  import took out before). */
export interface ShareCount {
  readonly run_id: string;
  readonly kind: string;
  readonly strings: number;
  readonly rules: RuleCount[];
  readonly by_kind: Record<Kind, number>;
  readonly cuts: number;
  readonly restorable: number;
  readonly already_redacted: number;
  /** The files the bundle carries, and those it names as left out (by path, or the whole list as uncounted). */
  readonly files: number;
  readonly files_omitted: number;
  /** Whether the run's files were read: false when the count had no data directory to read them from. */
  readonly files_read: boolean;
  /** Whether a share would be refused: the export fails closed (a scrub's final check finds a held value or a format left
   *  once cut, or the read-back finds a value), so no share of this run is made. Nothing else is counted then. */
  readonly blocked: boolean;
}

const zeroKinds = (): Record<Kind, number> => Object.fromEntries(CUT_KINDS.map((k) => [k, 0])) as Record<Kind, number>;

/** The count of the bundle `make` exports (run-export.ts exportBundle or runExport) for run `runId` of `kind`: each cut's
 *  rule, kind and whether it can be restored, never its value, shape or offsets. An export that failed closed
 *  (ExportFailed) is `blocked`, with nothing counted. */
export async function countExport(runId: string, kind: string, make: () => Promise<{ body: string }>, filesRead = true): Promise<ShareCount> {
  let body: string;
  try {
    body = (await make()).body;
  } catch (error) {
    if (!(error instanceof ExportFailed)) throw error;
    return { run_id: runId, kind, strings: 0, rules: [], by_kind: zeroKinds(), cuts: 0, restorable: 0, already_redacted: 0, files: 0, files_omitted: 0, files_read: filesRead, blocked: true };
  }
  const doc = JSON.parse(body) as { cuts: { rule: string; kind: string; restorable: boolean }[]; files: unknown[]; omitted: { what: string }[] } & Record<string, unknown>;
  const rules = new Map<string, { kind: string; restorable: boolean; count: number }>();
  for (const cut of doc.cuts) {
    const line = rules.get(cut.rule) ?? { kind: cut.kind, restorable: cut.restorable, count: 0 };
    line.count += 1;
    rules.set(cut.rule, line);
  }
  const lines = [...rules].map(([rule, line]) => ({ rule, ...line }));
  lines.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.rule.localeCompare(b.rule));
  const byKind = zeroKinds();
  for (const line of lines) byKind[line.kind as Kind] = (byKind[line.kind as Kind] ?? 0) + line.count;
  // The strings the bundle carries of the run: every part but its own record of the export (source, cuts, restored, sha).
  let strings = 0;
  let already = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      strings += 1;
      already += value.split("[redacted]").length - 1;
    } else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value !== null && typeof value === "object") for (const item of Object.values(value)) walk(item);
  };
  for (const part of ["run", "agent", "rows", "graph", "files", "omitted"]) walk(doc[part]);
  return {
    run_id: runId,
    kind,
    strings,
    rules: lines,
    by_kind: byKind,
    cuts: doc.cuts.length,
    restorable: doc.cuts.filter((cut) => cut.restorable).length,
    already_redacted: already,
    files: doc.files.length,
    files_omitted: doc.omitted.filter((one) => one.what === "file" || one.what === "files").length,
    files_read: filesRead,
    blocked: false,
  };
}

/** The count of what a share of run `runId` would carry: the bundle runExport makes from the store's reads, as the export
 *  route makes it (run-export-store.ts). `unknown` for a run the store does not hold, `withheld` when its cut can't be
 *  read here, `not_ended` for a run a share can't be made of yet. */
export async function shareCount(store: Store, runId: string, deps: ShareTextDeps): Promise<ShareCount | "unknown" | "withheld" | "not_ended"> {
  const row = await store.runs.get(runId).catch(() => undefined);
  if (!row) return "unknown";
  // The origin names the console's link, which the allowlist drops: none of it is read. A reserved .invalid name, so the
  // package scan finds no service endpoint.
  const viewDeps: ViewDeps = { origin: "http://scrub.invalid", serverSecrets: deps.serverSecrets, keyEnv: deps.keyEnv, sealKey: deps.sealKey, ...(deps.signIns ? { signIns: deps.signIns } : {}) };
  const cutDeps = { serverSecrets: deps.serverSecrets, ...(deps.signIns ? { signIns: deps.signIns } : {}), sealKey: deps.sealKey };
  const runReads: RunReadsDeps = {
    // The run's folder read as the server reads it (serverRunWorkspace: read-only, no runner claim).
    runWorkspace: async (_store, id) => (deps.data === undefined ? null : serverRunWorkspace(store, id, { data: deps.data, sealKey: deps.sealKey, env: deps.keyEnv() })),
    recordings: async () => null,
    env: deps.keyEnv(),
    sealKey: deps.sealKey,
    runFacts: (_store, id) => factsOverStore(store, id, viewDeps),
    withheld: (_store, id) => withheldOverStore(store, id, viewDeps),
    cutValues: (_store, id) => runCutValues(cutDeps, store, id),
    context: ctx,
  };
  const reads = exportReadsOverStore(store, runId, { view: viewDeps, timeline: deps, runReads, cut: cutDeps }, ctx);
  let kind = "";
  const read: ExportReads = { ...reads, view: async () => { const view = await reads.view(); kind = String(view?.kind ?? ""); return view; } };
  try {
    // The version names this server in the bundle's source, which the count does not read.
    const count = await countExport(runId, "", () => runExport(runId, read, { restore: [], version: "count" }), deps.data !== undefined);
    return { ...count, kind };
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return "unknown";
    if (error instanceof ApiError && error.code === "forbidden") return "withheld";
    if (error instanceof ApiError && error.code === "run_not_final") return "not_ended";
    throw error;
  }
}

const kindOrder = (kind: string): number => {
  const at = (CUT_KINDS as readonly string[]).indexOf(kind);
  return at === -1 ? CUT_KINDS.length : at;
};

/** The count as a table: one line per rule, totals by kind, and the line that says what a share would cut. */
export function countTable(count: ShareCount): string {
  const files = !count.files_read ? "its files not read here" : `${count.files} file${count.files === 1 ? "" : "s"} carried, ${count.files_omitted} left out`;
  const out: string[] = [`Run ${count.run_id} (${count.kind}): ${count.strings} strings a share would carry (${files}), counted.`, ""];
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
  if (count.blocked) out.push("A share of this run would be refused: once cut, it still holds a held value or a known key format no rule cut in place (or an object key holding a value), so nothing was counted.");
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
    const count = await shareCount(store, runId, { ...deps, data: dir });
    for (const line of warnings.splice(0)) io.err(line);
    if (count === "unknown") return unknown();
    if (count === "not_ended") {
      io.err(`agentrun-serve scrub: run ${runId} has not ended: a share is made of an ended run, so nothing was counted.`);
      return 1;
    }
    if (count === "withheld") {
      io.err(`agentrun-serve scrub: run ${runId} is withheld: this server can't read back what it was handed, a browser sign-in or the keys sealed with its launch (its seal key changed or is missing, or the record is damaged), so its held values are unknown and nothing was counted.`);
      return 1;
    }
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
