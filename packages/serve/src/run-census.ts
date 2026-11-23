// A run's census: where in each of its files the secrets its caller handed it sat when its end erased them (its launch's
// sealed part: its MCP credentials, its own model key and tool keys, store/seal.ts), never the secrets, nor a hash of one.
// The runner makes it just before its final patch, while the launch still holds them, over the run's files as the cut
// read serves them (GET /v2/runs/{id}/files/{path}?cut=run: the same Workspace, the same text rule, the same cap), and
// the end's commit writes it in the erased secrets' place (store/sqlite/run-patch.ts refuseLeftovers). A cut read after
// the end cuts a file by its entry when the file's bytes are still the ones counted (their SHA-256), and withholds it
// otherwise: a file with no entry (written after the end, past the census's caps, or one the census couldn't read), one
// changed since, or a run whose end erased its secrets with no census made under them ("unscanned", or "pending" left by
// a runner from before the census: store.ts CENSUS_UNSCANNED, CENSUS_PENDING). A later turn handed secrets anew keeps an
// earlier end's count of each file it left as it was (censusAfter).
import { createHash } from "node:crypto";
import { launchValuesOf } from "./handed-values.js";
import { heldSpans, type Span } from "./learn/secrets.js";
import { cutsAsText, listFiles, RUN_FILE_CUT_MAX } from "./run-files.js";
import { typeOf } from "./file-types.js";
import { CENSUS_PENDING, type RunPatch, type Store } from "./store/store.js";
import type { Workspace } from "./workspace/index.js";
import { RECORDINGS } from "./workspace/paths.js";
import { serverRunWorkspace, type ServerRunWorkspaceOptions } from "./workspace/server-run-workspace.js";

/** The most files one census counts. A run with more has the rest uncounted (`partial`), and each of those is withheld
 *  after its end. */
export const CENSUS_FILES_MAX = 2000;
/** The most bytes one census reads, its files' together (each at most RUN_FILE_CUT_MAX, the most a cut read answers):
 *  64 MiB. Past it the rest are uncounted, as past CENSUS_FILES_MAX. */
export const CENSUS_BYTES_MAX = 64 * 1024 * 1024;

/** One file as the census counted it: its bytes' SHA-256 (hex), and what the cut does to it for the handed secrets: the
 *  byte ranges [start, end) of its UTF-8 bytes cut in place, in order, or "whole" (the text is cut whole). */
export type CensusFile = { readonly sha256: string; readonly cut: readonly (readonly [number, number])[] | "whole" };
/** A census: every file counted, by its path under the run's folder; `partial` when files went uncounted (past a cap, a
 *  folder deeper than the list goes, a read that failed). */
export type Census = { readonly v: 1; readonly files: Readonly<Record<string, CensusFile>>; readonly partial?: true };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** `spans` of `text` (UTF-16 offsets, in order, apart) as byte ranges of its UTF-8 bytes. */
function byteRanges(text: string, spans: readonly Span[]): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  let byte = 0;
  for (const [start, end] of spans) {
    byte += Buffer.byteLength(text.slice(at, start));
    const from = byte;
    byte += Buffer.byteLength(text.slice(start, end));
    out.push([from, byte]);
    at = end;
  }
  return out;
}

/** The census of the run's files in `workspace` for `values` (the handed secrets, as the cut lists them): each file a
 *  cut read would answer (text by its type, UTF-8 with no NUL, at most RUN_FILE_CUT_MAX bytes; a byte order mark kept as
 *  a character, as the cut read keeps it, so each byte range falls where the text's cut does) counted with where
 *  redactSecrets would cut the values in it (heldSpans), up to CENSUS_FILES_MAX files and CENSUS_BYTES_MAX bytes. A file
 *  a cut read refuses (415, 413) is left out: it is refused after the end too. */
export async function censusOf(workspace: Workspace, values: readonly string[]): Promise<Census> {
  const { files, deep } = await listFiles(workspace, CENSUS_FILES_MAX, { owned: (name) => name === RECORDINGS });
  let partial = deep || files.length > CENSUS_FILES_MAX;
  let read = 0;
  const counted: Record<string, CensusFile> = {};
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const file of files.slice(0, CENSUS_FILES_MAX)) {
    if (!cutsAsText(typeOf(file.path)) || file.size_bytes > RUN_FILE_CUT_MAX) continue;
    if (file.unreadable) {
      partial = true;
      continue;
    }
    if (read + file.size_bytes > CENSUS_BYTES_MAX) {
      partial = true;
      break;
    }
    read += file.size_bytes;
    let bytes: Uint8Array;
    try {
      bytes = file.size_bytes === 0 ? new Uint8Array(0) : await workspace.read(file.path, { offset: 0, length: file.size_bytes });
    } catch {
      partial = true;
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const spans = heldSpans(text, values);
    counted[file.path] = { sha256: sha256(bytes), cut: spans === "whole" ? "whole" : byteRanges(text, spans) };
  }
  return { v: 1, files: counted, ...(partial ? { partial: true as const } : {}) };
}

/** What a run's census (its launch's census JSON text) says of file `path`, whose bytes are `bytes` and text `text`: the
 *  spans (UTF-16 offsets of `text`) to cut in place, "whole", or "unreadable" when the census can't say (the marker
 *  "unscanned", a census that doesn't parse, no entry for the file, bytes that are not the ones counted, ranges that
 *  don't fall on the text's characters): the file is withheld. */
export function censusCut(census: string, path: string, bytes: Uint8Array, text: string): Span[] | "whole" | "unreadable" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(census);
  } catch {
    return "unreadable";
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) return "unreadable";
  const files = (parsed as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || !Object.hasOwn(files, path)) return "unreadable";
  const entry = (files as Record<string, unknown>)[path] as { sha256?: unknown; cut?: unknown } | null;
  if (typeof entry !== "object" || entry === null || entry.sha256 !== sha256(bytes)) return "unreadable";
  if (entry.cut === "whole") return "whole";
  if (!Array.isArray(entry.cut)) return "unreadable";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const out: Span[] = [];
  let byte = 0;
  let char = 0;
  try {
    for (const range of entry.cut as unknown[]) {
      if (!Array.isArray(range) || range.length !== 2) return "unreadable";
      const [from, to] = range as unknown[];
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || (from as number) < byte || (to as number) <= (from as number) || (to as number) > bytes.length) return "unreadable";
      const start = char + decoder.decode(bytes.subarray(byte, from as number)).length;
      const end = start + decoder.decode(bytes.subarray(from as number, to as number)).length;
      out.push([start, end]);
      byte = to as number;
      char = end;
    }
  } catch {
    return "unreadable";
  }
  return char <= text.length ? out : "unreadable";
}

/** A census parsed, or undefined for text that is no census (a marker, damaged). */
function parsedCensus(text: string): Census | undefined {
  try {
    const parsed = JSON.parse(text) as Census;
    return typeof parsed === "object" && parsed !== null && parsed.v === 1 && typeof parsed.files === "object" && parsed.files !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Byte ranges `a` and `b` (each in order, apart) as one list, in order, overlapping ones joined. */
function unionRanges(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of [...a, ...b].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** The census an end writes over `prior`, its launch's census before it (RunLaunchRow.census), given `next`, the one it
 *  made for the secrets the launch holds now: `next` when no end counted any before (null, CENSUS_PENDING); each file of
 *  `next` still byte for byte as an earlier end counted it, with both counts' cuts; and no entry for a file written or
 *  changed since (it may hold what that earlier turn was handed, which this end can't name, so it is withheld).
 *  Undefined when an earlier end left no census (a marker): nothing says where those sat, and the end writes the marker. */
export function censusAfter(prior: string | null, next: Census): Census | undefined {
  if (prior === null || prior === CENSUS_PENDING) return next;
  const before = parsedCensus(prior);
  if (!before) return undefined;
  const files: Record<string, CensusFile> = {};
  for (const [path, file] of Object.entries(next.files)) {
    const was = Object.hasOwn(before.files, path) ? before.files[path] : undefined;
    if (!was || was.sha256 !== file.sha256) continue;
    files[path] = { sha256: file.sha256, cut: was.cut === "whole" || file.cut === "whole" ? "whole" : unionRanges(was.cut, file.cut) };
  }
  return { v: 1, files, ...(next.partial ? { partial: true as const } : {}) };
}

/** A runner's census of each run it ends (runner.ts RunnerOptions.census): run `runId`'s launch's sealed part opened with
 *  `options.sealKey` (handed-values.ts launchValuesOf), and the run's files counted for it (censusOf) through the
 *  Workspace the cut read reads them through (serverRunWorkspace), with the sealed bytes it was made under. Undefined for
 *  a run whose launch holds none, whose sealed part doesn't open here, or whose earlier end left no census (its end writes
 *  the marker); over an earlier end's census, what both counted (censusAfter). A run with no folder yet has none to
 *  count. */
export function runCensus(store: Pick<Store, "runs" | "settings" | "sealedKeys">, options: ServerRunWorkspaceOptions): (runId: string) => Promise<RunPatch["census"] | undefined> {
  return async (runId) => {
    const row = await store.runs.launch(runId);
    if (row.sealed === null) return undefined;
    const values = launchValuesOf(options.sealKey, runId, row.sealed);
    if (values === "unreadable") return undefined;
    const workspace = await serverRunWorkspace(store, runId, options);
    const census = censusAfter(row.census, workspace ? await censusOf(workspace, values) : { v: 1, files: {} });
    return census ? { json: JSON.stringify(census), sealed: row.sealed } : undefined;
  };
}
