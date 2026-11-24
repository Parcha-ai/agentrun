// GET /runs/{id}/export: an ended run as the `agentrun.share/1` bundle, the one document a share page renders and a share
// host stores (tl-share's share-design.md §1-§3). Split as #3431's agent package is: `exportBundle` is pure (allowlist,
// caps, scrub, digest) over plain data, and `gatherRunExport` reads that data through the server's own served functions
// (the run view, its served Timeline rows, a workflow's graph, its files) and the run's cut, read last.
//
// Every string the bundle carries from the run is cut by the scrubber (secret-cut.ts scrub, cut mode) with the run's held
// values; object keys are structure and are not cut. The document is then read back: a count-mode scrub of its own bytes
// that finds a value no restore declared fails the export closed. So does any scrub that answers `{ok:false}` or throws:
// `ExportFailed`, which the route answers 500 with no body.
//
// A cut record carries where the cut is (an RFC 6901 pointer, the span in the cut string), its rule, kind, whether it may
// be restored and its shape, and an id made of the run, the pointer, the rule and its ordinal there: never of the value.
// `restore` names cut ids to keep in place (the scrubber's `keep`, asked of restorable cuts alone): a restored cut moves
// to `restored`. An id of a cut that is not restorable, or of no cut, refuses the export (400): nothing is restored then.
import { createHash } from "node:crypto";
import { packageSha256 } from "./agent-package.js";
import { ApiError } from "./errors.js";
import { SHARE_RUN_FIELDS } from "./scrub-command.js";
import { type Cut, SCRUB_RULES, scrub, type ScrubOptions, type ScrubResult } from "./secret-cut.js";
import { type CallContext, callContexts, effectContext, rowOutput } from "./share-context.js";
import { WITHHELD_SIGN_IN } from "./run-view.js";
import { stable } from "./validate.js";

export { SHARE_RUN_FIELDS };

export const SHARE_FORMAT = "agentrun.share/1";
/** The scrubber's version as the bundle names it: its interface (tl-share's CONTRACT-scrub-beta1.md). */
export const SCRUBBER_VERSION = 1;

/** The caps: the whole document as an imported package's (template-source.ts IMPORT_LIMITS.packageBytes); each text
 *  file as an import's (import.ts MAX_FILE_BYTES), their total, and how many. */
export const EXPORT_CAPS = Object.freeze({ documentBytes: 8 * 1024 * 1024, fileBytes: 256 * 1024, filesBytes: 4 * 1024 * 1024, files: 200 });
export type ExportCaps = typeof EXPORT_CAPS;

/** The scrubber's rules, named: sha256 over each rule's `id:kind`, one a line. A host reads which rules cut a bundle. */
export const SCRUB_RULES_DIGEST = createHash("sha256").update(SCRUB_RULES.map((rule) => `${rule.id}:${rule.kind}`).join("\n")).digest("hex");

/** A cut of the bundle: where it is, its rule and kind, whether a preview may restore it, its shape. Never its value. */
export type CutRecord = { id: string; at: string; start: number; end: number; rule: string; kind: Cut["kind"]; restorable: boolean; shape: string };
/** A restored cut: its value is in place again, at `start`-`end` of the string at `at`. */
export type RestoredRecord = { id: string; at: string; start: number; end: number; rule: string; kind: Cut["kind"] };
export type Omitted = { what: "file"; path: string; why: "binary" | "too_large" | "over_total" | "over_count" | "unreadable" } | { what: "files"; why: "list_truncated" } | { what: "recordings"; why: "never" };

/** A run's file the export may carry: its path, its size as listed, and its bytes up to `limit` (read only when it fits). */
export type ExportFile = { readonly path: string; readonly size: number; readonly unreadable?: boolean; read(limit: number): Promise<Uint8Array> };

/** The scrubber in cut mode: `scrub` itself, or a test's stand-in. */
export type CutScrub = (text: string, opts: ScrubOptions & { mode: "cut" }) => Promise<ScrubResult>;

export interface ExportInput {
  readonly runId: string;
  /** The run's agent: its name (its id, revision and definition never travel). */
  readonly agent: { readonly name: string };
  /** The run as GET /runs/{id} serves it (store-view.ts viewOverStore): the allowlist is taken of it. */
  readonly view: Readonly<Record<string, unknown>>;
  /** Its Timeline rows as served (run-timeline-served.ts servedTimelineRows). */
  readonly rows: readonly unknown[];
  /** Each call's context by its tool_use_id (share-context.ts callContexts): a row's output of that call is cut with it
   *  (ruling LVI). None: no row's output has any. */
  readonly contexts?: ReadonlyMap<string, CallContext>;
  /** A workflow run's graph as GET /runs/{id}/graph serves it; null for an agentic run. */
  readonly graph: Readonly<Record<string, unknown>> | null;
  readonly files: readonly ExportFile[];
  /** Whether the run's file list was cut at its cap (run-reads-over-store.ts listRunFiles `truncated`). */
  readonly filesTruncated: boolean;
  /** The run's cut set (run-cut.ts runCutValues), read after everything above. */
  readonly held: readonly string[];
  /** Cut ids to keep in place. */
  readonly restore: readonly string[];
  /** This server's version. */
  readonly version: string;
  readonly scrub?: CutScrub;
  readonly caps?: Partial<ExportCaps>;
}

/** The export failed closed: a scrub answered `{ok:false}` or threw, or the read-back found a value. No bundle. */
export class ExportFailed extends Error {
  constructor(why: string) {
    super(`the export failed closed: ${why}`);
    this.name = "ExportFailed";
  }
}

const RESTORE_ID = /^c_[0-9a-f]{16}$/;
/** The most ids one `restore=` may name. */
const RESTORE_MAX = 1000;

/** The cut ids `?restore=` names: comma-separated, the parameter repeated or not, each once. Anything that is not an id is
 *  a 400, its text never quoted (a person may paste a value there). */
export function restoreIdsOf(url: URL): string[] {
  const ids = url.searchParams.getAll("restore").flatMap((value) => value.split(",")).map((id) => id.trim()).filter((id) => id !== "");
  if (ids.some((id) => !RESTORE_ID.test(id))) throw new ApiError("bad_request", "restore takes cut ids (c_ and 16 hex digits), comma-separated, as the bundle's cuts name them");
  const unique = [...new Set(ids)];
  if (unique.length > RESTORE_MAX) throw new ApiError("bad_request", `restore names at most ${RESTORE_MAX} cut ids`);
  return unique;
}

/** A cut's id: the run, the string's pointer, the rule and the ordinal of that rule's cuts in that string. */
const cutId = (runId: string, at: string, rule: string, ordinal: number): string =>
  `c_${createHash("sha256").update(`${runId}\u0000${at}\u0000${rule}\u0000${ordinal}`).digest("hex").slice(0, 16)}`;

/** An RFC 6901 pointer's token for `key`. */
const token = (key: string | number): string => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

/** The run's allowlisted view: SHARE_RUN_FIELDS (those it has), and `imported_from` with its `source` alone. */
function runOf(view: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const run: Record<string, unknown> = {};
  for (const field of SHARE_RUN_FIELDS) if (Object.hasOwn(view, field)) run[field] = view[field];
  const imported = view.imported_from as { source?: unknown } | null | undefined;
  run.imported_from = imported && typeof imported.source === "string" ? { source: imported.source } : null;
  return run;
}

/** The fields of the graph's `run` a share carries: its status, pause and times. Its id, agent and revision are dropped,
 *  as the run allowlist drops them. */
const GRAPH_RUN_FIELDS = ["status", "paused", "startedAt", "endedAt"] as const;

/** A workflow run's graph as its route serves it, but for its `read_at` (the read's own time: it would make two exports
 *  of one run differ) and its run's ids. */
function graphOf(graph: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null {
  if (!graph) return null;
  const { read_at: _readAt, run, ...rest } = graph;
  if (run === null || typeof run !== "object") return rest;
  const kept: Record<string, unknown> = {};
  for (const field of GRAPH_RUN_FIELDS) if (Object.hasOwn(run, field)) kept[field] = (run as Record<string, unknown>)[field];
  return { ...rest, run: kept };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
/** `bytes` as text when they are UTF-8 with no NUL byte (a text file), else undefined. */
function textOf(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The files the caps let through, path-sorted, as text; every other one in `omitted` with why. A file over a cap is never
 *  read; one read is read no further than its cap. */
async function filesOf(files: readonly ExportFile[], truncated: boolean, caps: ExportCaps): Promise<{ carried: { path: string; content: string }[]; omitted: Omitted[] }> {
  const carried: { path: string; content: string }[] = [];
  const omitted: Omitted[] = [];
  let total = 0;
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const skip = (why: Extract<Omitted, { what: "file" }>["why"]) => void omitted.push({ what: "file", path: file.path, why });
    if (file.unreadable) skip("unreadable");
    else if (file.size > caps.fileBytes) skip("too_large");
    else if (total + file.size > caps.filesBytes) skip("over_total");
    else if (carried.length >= caps.files) skip("over_count");
    else {
      const bytes = await file.read(caps.fileBytes + 1);
      const text = textOf(bytes);
      if (bytes.length > caps.fileBytes) skip("too_large");
      else if (total + bytes.length > caps.filesBytes) skip("over_total");
      else if (text === undefined) skip("binary");
      else {
        total += bytes.length;
        carried.push({ path: file.path, content: text });
      }
    }
  }
  if (truncated) omitted.push({ what: "files", why: "list_truncated" });
  omitted.push({ what: "recordings", why: "never" });
  return { carried, omitted };
}

/** The bundle of one ended run: its body (canonical JSON, byte-identical for the same run) and its sha256. Throws
 *  ExportFailed when any scrub fails or the read-back finds a value, ApiError 400 for a restore id it can't honour, and
 *  ApiError 413 for a document over its cap. */
export async function exportBundle(input: ExportInput): Promise<{ body: string; sha256: string }> {
  const caps: ExportCaps = { ...EXPORT_CAPS, ...input.caps };
  const cutPass: CutScrub = input.scrub ?? ((text, opts) => scrub(text, opts));
  const restore = new Set(input.restore);
  const { carried, omitted } = await filesOf(input.files, input.filesTruncated, caps);
  const kind = String(input.view.kind);
  // What is cut: everything that came from the run. The format and source are this server's own words.
  const parts: Record<string, unknown> = {
    agent: { name: input.agent.name, kind },
    run: runOf(input.view),
    rows: input.rows,
    graph: graphOf(input.graph),
    files: carried.map((file) => ({ path: file.path, content: file.content })),
    omitted,
  };

  const cuts: CutRecord[] = [];
  const restored: RestoredRecord[] = [];
  const seen = new Map<string, boolean>(); // every cut's id: whether it is restorable
  const cutString = async (text: string, at: string, context?: CallContext): Promise<string> => {
    // keep() is asked of restorable cuts alone, in the order of the string's cuts; a rule's cuts are all of one kind, so
    // counting a rule's cuts here gives the ordinals the records below are named by.
    const asked = new Map<string, number>();
    const keep = (cut: Readonly<Cut>): boolean => {
      const ordinal = asked.get(cut.rule) ?? 0;
      asked.set(cut.rule, ordinal + 1);
      return restore.has(cutId(input.runId, at, cut.rule, ordinal));
    };
    let result: ScrubResult;
    try {
      result = await cutPass(text, { mode: "cut", held: input.held, keep, ...(context?.path !== undefined ? { path: context.path } : {}), ...(context?.command !== undefined ? { command: context.command } : {}) });
    } catch {
      throw new ExportFailed("a scrub threw");
    }
    if (!result.ok) throw new ExportFailed("a scrub failed");
    const ordinals = new Map<string, number>();
    for (const cut of result.cuts) {
      const ordinal = ordinals.get(cut.rule) ?? 0;
      ordinals.set(cut.rule, ordinal + 1);
      const id = cutId(input.runId, at, cut.rule, ordinal);
      if (cut.outStart === undefined || cut.outEnd === undefined) throw new ExportFailed("a cut has no span in its output");
      seen.set(id, cut.restorable);
      if (cut.kept) {
        if (!cut.restorable || !restore.has(id)) throw new ExportFailed("a cut was kept that no restore named");
        restored.push({ id, at, start: cut.outStart, end: cut.outEnd, rule: cut.rule, kind: cut.kind });
      } else cuts.push({ id, at, start: cut.outStart, end: cut.outEnd, rule: cut.rule, kind: cut.kind, restorable: cut.restorable, shape: cut.shape });
    }
    return result.text;
  };
  // Every string, keys in sorted order (the canonical order the body is written in), each scrubbed once. `context` is the
  // call's whose output the value is (ruling LVI): every string inside it is cut with it.
  const walk = async (value: unknown, at: string, context?: CallContext): Promise<unknown> =>
    typeof value === "string" ? cutString(value, at, context) : each(value, at, (item, here) => walk(item, here, context));
  // An array's items or an object's fields, each walked by `child` with its key; anything else as walk takes it.
  const each = async (value: unknown, at: string, child: (item: unknown, at: string, key: string) => Promise<unknown>): Promise<unknown> => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const [index, item] of value.entries()) out.push(await child(item, `${at}/${index}`, String(index)));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) out[key] = await child((value as Record<string, unknown>)[key], `${at}/${token(key)}`, key);
      return out;
    }
    return typeof value === "string" ? walk(value, at) : value;
  };
  // A row whose field holds a call's output (a result's preview, an approval outcome's text: share-context.ts rowOutput):
  // that field cut with the call's context, its other fields without. The pointers are the same either way.
  const contexts = input.contexts ?? new Map<string, CallContext>();
  const walkRow = (row: unknown, at: string): Promise<unknown> => {
    const output = rowOutput(row, contexts);
    return output === undefined ? walk(row, at) : each(row, at, (item, here, key) => walk(item, here, key === output.field ? output.context : undefined));
  };
  // A workflow's call (graph `effects[i]`): its output cut with its own tool's and input's context, the rest without.
  const walkEffect = (effect: unknown, at: string): Promise<unknown> => {
    const context = effectContext(effect);
    return context === undefined ? walk(effect, at) : each(effect, at, (item, here, key) => walk(item, here, key === "output" ? context : undefined));
  };
  const walkPart = (key: string, value: unknown, at: string): Promise<unknown> =>
    key === "rows" ? each(value, at, walkRow)
      : key === "graph" ? each(value, at, (item, here, field) => (field === "effects" ? each(item, here, walkEffect) : walk(item, here)))
      : walk(value, at);
  const cutParts: Record<string, unknown> = {};
  for (const key of Object.keys(parts).sort()) {
    if (key !== "files") cutParts[key] = await walkPart(key, parts[key], `/${key}`);
  }
  // A file's content is cut knowing its path (a .env* file or one under ~/.ssh is dropped whole); then its bytes and digest
  // are the carried text's.
  const files: Record<string, unknown>[] = [];
  for (const [index, file] of carried.entries()) {
    const path = await cutString(file.path, `/files/${index}/path`);
    const content = await cutString(file.content, `/files/${index}/content`, { path: file.path });
    files.push({ path, bytes: Buffer.byteLength(content), sha256: packageSha256([{ path, encoding: "utf8", content }]), encoding: "utf8", content });
  }

  // Every id the restore named must be a restorable cut's: the scrubber kept those, and only those.
  const refused = input.restore.filter((id) => seen.get(id) !== true);
  if (refused.length) {
    const unrestorable = refused.filter((id) => seen.get(id) === false);
    throw new ApiError("bad_request", unrestorable.length
      ? `${unrestorable.join(", ")} ${unrestorable.length === 1 ? "is a cut" : "are cuts"} of a known key format, a value this server holds, or a dump: not restorable. Nothing was restored.`
      : `This run's bundle has no cut ${refused.join(", ")}. Nothing was restored.`);
  }

  const doc: Record<string, unknown> = {
    format: SHARE_FORMAT,
    source: { agentrun: input.version, scrubber: { version: SCRUBBER_VERSION, rules: SCRUB_RULES_DIGEST } },
    ...cutParts,
    files,
    cuts,
    restored,
  };
  const sha256 = createHash("sha256").update(stable(doc)).digest("hex");
  const body = stable({ ...doc, sha256 });
  if (Buffer.byteLength(body) > caps.documentBytes) throw new ApiError("export_too_large", `This run's bundle is over ${caps.documentBytes} bytes; nothing of it is cut short, so it does not export.`);
  await readBack(body, input.held, restored.length > 0);
  return { body, sha256 };
}

/** The bundle read back as a host reads it: the scrubber's count over its whole text. A cut of a kind that is never
 *  restored (a known format, a held value, a dump) fails the export; so does a restorable one where nothing was restored. */
async function readBack(body: string, held: readonly string[], restored: boolean): Promise<void> {
  let found: Cut[];
  try {
    found = (await scrub(body, { mode: "count", held })).cuts;
  } catch {
    throw new ExportFailed("its read-back threw");
  }
  if (found.some((cut) => !cut.restorable || !restored)) throw new ExportFailed("its read-back found a value the cut pass left");
}

/** What the export reads of a run, each through the function that serves it (the switch wires the server's own). */
export interface ExportReads {
  /** The run as GET /runs/{id} serves it, or undefined for no such run. */
  view(): Promise<Readonly<Record<string, unknown>> | undefined>;
  /** Whether the run is withheld: this server can't read back the sign-in it was handed. */
  withheld(): Promise<boolean>;
  /** Its Timeline rows as served. */
  rows(): Promise<readonly unknown[]>;
  /** Its Timeline rows read with their calls' arguments (calls=true): read only for each call's context
   *  (share-context.ts callContexts). Never carried: they hold a call's whole input and a longer head of its result. */
  calls(): Promise<readonly unknown[]>;
  /** A workflow run's graph as served. */
  graph(): Promise<Readonly<Record<string, unknown>>>;
  /** Its files as listed, each readable, and whether the list was cut at its cap. */
  files(): Promise<{ files: readonly ExportFile[]; truncated: boolean }>;
  /** Agent `agentId`'s name. */
  agentName(agentId: string): Promise<string | undefined>;
  /** The run's cut set (run-cut.ts runCutValues). */
  cut(): Promise<{ values: string[] } | "unreadable">;
}

/** Run `runId`'s bundle, gathered: its view, rows, graph (a workflow's) and files, then its cut set, read last (the cut
 *  only grows, so the last read holds every value an earlier read cut by). 409 run_not_final while it is not settled, 403
 *  while it is withheld (before anything else of it is read, and again if its cut can't be read at the end). */
export async function runExport(runId: string, reads: ExportReads, options: Pick<ExportInput, "restore" | "version" | "scrub" | "caps">): Promise<{ body: string; sha256: string }> {
  const view = await reads.view();
  if (!view) throw new ApiError("not_found", `There is no run ${runId}.`);
  // Settled: terminal, its end in the store, and nothing more of it in flight (its view's poll_after_ms is 0).
  if (view.poll_after_ms !== 0) throw new ApiError("run_not_final", `The run ${runId} has not ended: a run exports once it has.`);
  if (await reads.withheld()) throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  const rows = await reads.rows();
  const contexts = callContexts(await reads.calls());
  const graph = view.kind === "workflow" ? await reads.graph() : null;
  const { files, truncated } = await reads.files();
  const name = (typeof view.agent_id === "string" ? await reads.agentName(view.agent_id) : undefined) ?? "";
  const cut = await reads.cut();
  if (cut === "unreadable") throw new ApiError("forbidden", WITHHELD_SIGN_IN);
  return exportBundle({ runId, agent: { name }, view, rows, contexts, graph, files, filesTruncated: truncated, held: cut.values, ...options });
}
