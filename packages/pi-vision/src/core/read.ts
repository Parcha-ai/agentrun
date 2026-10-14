// The media half of `read`, behind its unchanged arguments: an image fitted to the lead's limits, a document's text
// paged like a file, a page rendered and shown, a scan shown up to the page budget, a spreadsheet's cells, a video's
// frames or window, a recording by handle. Window and page arguments on the wrong kind of file are refused in one line,
// and the zero values a strict route fills in are treated as absent. A plain text file is not ours: the host's read
// serves it. Each kind is read by its own reader; this module decides the kind, checks the arguments and the host's
// policy, pages a document's text and turns what cannot be done into a miss the model can act on.

import { createHash } from "node:crypto";
import type { MissCode } from "./contract.js";
import { visionContext, type VisionBinaryReader, type VisionEnv, type VisionFileInfo } from "./env.js";
import { fileLook, lookKey, type Filing, type LookRecord } from "./evidence.js";
import { formatFragment } from "./fragments.js";
import { DESCRIBE_ASK, type ImageSize, type MediaDetails } from "./guard.js";
import type { CallContext, CallSetup, ImageContent, ReadArgs, TextContent, ToolResult } from "./host.js";
import type { ImageProcessor } from "./image.js";
import type { Kind } from "./kinds.js";
import { SOURCE_BYTES_IN_PROCESS, type Limits } from "./limits.js";
import { firstLine, linkSafe, MISS_ACTION, refusal, reportMiss } from "./misses.js";
import { PACKAGE_KINDS } from "./readers.js";
import type { Fit } from "./plan.js";
import type { Provider, ProviderSource } from "./provider.js";

/** A source's kind from its first bytes and its name (`sniffKind`'s answer, kinds.ts), or why the two disagree. */
type SniffOutcome =
  | { readonly ok: true; readonly kind: Kind; readonly mimeType: string | null; readonly signature?: string }
  | { readonly ok: false; readonly code: "unsupported"; readonly reason: string };

/** What a kind's reader is asked: the source in the environment, the path as the model wrote it, and the arguments.
 *  `source.path` is a private copy of the bytes that were hashed, and `data` those bytes, for a source the process
 *  holds; a larger source is read where it is. A reader never opens the model's own path. */
export type KindRequest = {
  readonly source: ProviderSource; readonly data?: Uint8Array; readonly name: string; readonly mimeType: string; readonly width?: number; readonly height?: number;
  readonly ask?: string; readonly page?: number; readonly fromS?: number; readonly toS?: number;
};
/** What a kind's reader works with: the environment; the limits its images must meet (the lead's, with the eyes' image
 *  limits when the lead takes no images); where kept derivations go, named by the source's hash and their parameters
 *  (absent: nothing is kept); a directory removed when the read ends; and the image processor and providers. */
export type KindContext = {
  readonly env: VisionEnv; readonly signal: AbortSignal | undefined; readonly limits: Limits; readonly deriveDir?: string; readonly tempDir: string;
  readonly images?: ImageProcessor; readonly providers: readonly Provider[];
};
/** A kind's answer: what the model reads (a document's whole `text`, page-marked, is paged here after the first text
 *  block), a miss with its cause and any text that still came back, or a refusal of the arguments in one line. */
export type KindResult =
  | { readonly content: readonly (TextContent | ImageContent)[]; readonly text?: string; readonly media?: MediaDetails; readonly fit?: Fit;
      /** What a document read as text says of itself in the result's `details.document`: where its text is kept, who extracted it, its page or pages. */
      readonly document?: Readonly<Record<string, unknown>> }
  | { readonly miss: MissCode; readonly reason: string; readonly text?: string }
  | { readonly refusal: string };
export type KindReader = (request: KindRequest, context: KindContext) => Promise<KindResult>;

/** The package's own kind wiring: the kind of a file's first bytes, an image header's pixels, and a reader per kind. */
export type ReadKinds = {
  readonly sniff: (head: Uint8Array, path: string) => SniffOutcome;
  readonly sizeOf: ImageSize;
  readonly readers: Readonly<Partial<Record<Kind, KindReader>>>;
};


/** Bytes a kind is decided from: a header's first megabyte holds its pixel size behind any metadata. */
const HEAD_BYTES = 1024 * 1024;
/** Bytes hashed per step. */
const HASH_CHUNK_BYTES = 1024 * 1024;
/** One page of a document's text: pi's read tool's own limits, 2,000 lines and 50 KiB of UTF-8 (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`). */
const PAGE_LINES = 2000;
const PAGE_BYTES = 50 * 1024;

/** What a read says of a source that was not one version while it was read, and the sink that files nothing for it: no
 *  hash names what was read. */
const CHANGED = "the file changed while it was read, so what was read is not one version of it; read it again";
const NO_RECEIPT = { file: async () => null };

const num = (value: unknown): number | undefined => (value === undefined || value === null || value === "" ? undefined : Number(value));
const asked = (args: ReadArgs) => (typeof args.ask === "string" && args.ask.trim() ? args.ask.trim() : undefined);

/** A tool on a strict function-calling route receives every optional argument, filled with its zero value. A value
 *  that is the argument's own default, or a window or page the target has none of, is the absent argument. Two shapes
 *  stay as sent, because a filler and a real request send the same values: `from_s: 5, to_s: 0` (refused, since
 *  `to_s: 0` alone is also the real empty window), and `page: 1` on a document (read, since it is the real first page). */
export function withoutStrictDefaults(args: ReadArgs, target: { readonly windowed: boolean; readonly paged: boolean }): ReadArgs {
  const out: Record<string, unknown> = { ...args };
  const [fromS, toS, page] = [num(out.from_s), num(out.to_s), num(out.page)];
  if ((fromS ?? 0) === 0 && (toS === undefined || toS === 0 || (!target.windowed && toS === 1))) { delete out.from_s; delete out.to_s; }
  if (!target.paged && (page === 0 || page === 1)) delete out.page;
  if (num(out.offset) === 0 || num(out.offset) === 1) delete out.offset;
  if (num(out.char_offset) === 0) delete out.char_offset;
  if (num(out.limit) === 0) delete out.limit;
  return out as ReadArgs;
}

/** One window of a document's text, from line `offset` (1-based) and `charOffset` characters into it, within `limit`
 *  lines and one page, with the line that says where to continue. */
function pageText(text: string, name: string, offset = 1, limit?: number, charOffset = 0): string {
  const lines = text.split("\n");
  if (offset > lines.length) throw new RangeError(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  const last = Math.min(lines.length, offset - 1 + Math.min(limit ?? PAGE_LINES, PAGE_LINES));
  const from = Math.min(charOffset, lines[offset - 1]!.length);
  const window = [lines[offset - 1]!.slice(from), ...lines.slice(offset, last)].join("\n");
  const bytes = Buffer.from(window, "utf8");
  if (bytes.length <= PAGE_BYTES) return last < lines.length ? `${window}\n\n[${lines.length - last} more lines in file. Use offset=${last + 1} to continue.]` : window;
  // A window ends where a character starts, so a character cut by the page goes whole to the next.
  let end = PAGE_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const cut = bytes.subarray(0, end).toString("utf8");
  const breaks = cut.split("\n").length - 1;
  const endLine = offset + breaks;
  const endChar = breaks ? cut.length - cut.lastIndexOf("\n") - 1 : from + cut.length;
  return `${cut}\n\n[Showing line ${offset} character ${from} to line ${endLine} character ${endChar} of ${name} (${lines.length} lines). Use offset=${endLine}${endChar ? ` char_offset=${endChar}` : ""} to continue.]`;
}

async function sha256Of(env: VisionEnv, path: string, size: number, signal: AbortSignal | undefined): Promise<string> {
  const ctx = visionContext(signal);
  const opened = await env.openBinaryReader(path, undefined, ctx);
  if (!opened.ok) throw opened.error;
  const hash = createHash("sha256");
  try {
    for (let at = 0; at < size; at += HASH_CHUNK_BYTES) {
      const chunk = await opened.value.read(at, Math.min(HASH_CHUNK_BYTES, size - at), ctx);
      if (!chunk.ok) throw chunk.error;
      hash.update(chunk.value);
    }
  } finally { await opened.value.close(ctx); }
  return hash.digest("hex");
}

/** A file's bytes through one opened reader, a chunk at a time and never more than the process may hold: `over` when the
 *  file holds more (whatever its size was a moment ago), null when it cannot be opened or read. */
async function holdSource(env: VisionEnv, path: string, signal: AbortSignal | undefined): Promise<Uint8Array | "over" | null> {
  const ctx = visionContext(signal);
  const opened = await env.openBinaryReader(path, undefined, ctx);
  if (!opened.ok) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await opened.value.read(total, HASH_CHUNK_BYTES, ctx);
      if (!chunk.ok) return null;
      if (!chunk.value.length) break;
      total += chunk.value.length;
      if (total > SOURCE_BYTES_IN_PROCESS) return "over";
      chunks.push(chunk.value);
    }
  } finally { await opened.value.close(ctx); }
  return Buffer.concat(chunks, total);
}

/** `env` with a held source's private copy at `path` read from memory, and written there only when a program that names
 *  the path runs: once a read, removed with the read's temp directory. A reader that works in memory never needs it. */
function holding(env: VisionEnv, path: string, data: Uint8Array, mtimeMs: number): VisionEnv {
  const info: VisionFileInfo = { name: path.slice(path.lastIndexOf("/") + 1), path, kind: "file", size: data.length, mtimeMs };
  const reader: VisionBinaryReader = { info: async () => ({ ok: true, value: info }), read: async (offset, length) => ({ ok: true, value: data.subarray(offset, offset + length) }), close: async () => undefined };
  let written: ReturnType<VisionEnv["writeFile"]> | undefined;
  return {
    get id() { return env.id; },
    get cwd() { return env.cwd; },
    set cwd(value) { env.cwd = value; },
    readBinaryFile: async (file, context) => (file === path ? { ok: true, value: data } : env.readBinaryFile(file, context)),
    openBinaryReader: async (file, opened, context) => (file === path ? { ok: true, value: reader } : env.openBinaryReader(file, opened, context)),
    fileInfo: async (file, context) => (file === path ? { ok: true, value: info } : env.fileInfo(file, context)),
    writeFile: (file, content, context) => env.writeFile(file, content, context),
    renameFile: (from, to, context) => env.renameFile(from, to, context),
    createDir: (dir, created, context) => env.createDir(dir, created, context),
    createTempDir: (prefix, context) => env.createTempDir(prefix, context),
    remove: (file, removed, context) => env.remove(file, removed, context),
    exec: async (command, run, context) => {
      if ((typeof command === "string" ? [command] : command).some((arg) => arg.includes(path))) {
        const wrote = await (written ??= env.writeFile(path, data, context));
        if (!wrote.ok) return wrote;
      }
      return env.exec(command, run, context);
    },
  };
}

/** A handle such as `session:<id>`: the scheme and the id. `session` is always a handle; another scheme is one when the
 *  host gives it a source. */
const HANDLE = /^([a-z]+):([A-Za-z0-9_-]{1,128})$/;
function handleOf(path: string, sources: CallSetup["sources"]): { scheme: string; id: string } | null {
  const match = HANDLE.exec(path.trim());
  return match && (match[1] === "session" || sources?.[match[1]!]) ? { scheme: match[1]!, id: match[2]! } : null;
}

/** A file's size, modification time, first bytes and kind; null when the path is not a file that opens. */
async function sniffFile(env: VisionEnv, name: string, sniff: ReadKinds["sniff"], signal: AbortSignal | undefined): Promise<{ size: number; mtimeMs: number; head: Uint8Array; sniffed: SniffOutcome } | null> {
  const ctx = visionContext(signal);
  const info = await env.fileInfo(name, ctx);
  if (!info.ok || info.value.kind !== "file") return null;
  const opened = await env.openBinaryReader(name, undefined, ctx);
  if (!opened.ok) return null;
  const head = await opened.value.read(0, Math.min(HEAD_BYTES, info.value.size), ctx).finally(() => opened.value.close(ctx));
  return head.ok ? { size: info.value.size, mtimeMs: info.value.mtimeMs, head: head.value, sniffed: sniff(head.value, name) } : null;
}

/** The extension a private copy keeps, so a program that reads a file by its name still knows what it is. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1);
  return ext && ext.length <= 8 && [...ext].every((c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) ? `.${ext}` : "";
};

/** A miss the model can act on, filed as a failed look and told to the host. */
async function missResult(filing: Filing, name: string, kind: Kind, sha256: string, code: MissCode, cause: string, args: ReadArgs, text?: string): Promise<ToolResult> {
  const reason = linkSafe(cause);
  const ask = asked(args);
  const page = num(args.page);
  const record: LookRecord = { tool: "look", args: { path: name, ...(ask ? { ask } : {}), ...(page !== undefined ? { page } : {}), model: "none", native: false }, status: "failed", facts: { sha256, kind, fragment: "", key: lookKey({ sha256, fragment: "", ask, model: "none" }) }, body: "" };
  const receipt = await reportMiss(filing, "read", record, { code, reason });
  return {
    content: [{ type: "text", text: `${name} could not be read: ${reason}. The file is saved at ${name}.${receipt ? ` Receipt filed at ${receipt}.` : ""} ${MISS_ACTION[code]}${text?.trim() ? `\n${text.trim()}` : ""}` }],
    details: { path: name, ...(receipt ? { look: receipt } : {}), miss: { code } },
  };
}

/** A recording by handle: its source provider's answer to the question about that window, filed as a look. */
async function readRecording(scheme: string, id: string, handle: string, raw: ReadArgs, call: CallContext, setup: CallSetup, filing: Filing): Promise<ToolResult> {
  const args = withoutStrictDefaults(raw, { windowed: true, paged: false });
  const [fromS, toS] = [num(args.from_s), num(args.to_s)];
  if (num(args.page) !== undefined) return refusal(`page applies to PDF files only; ${handle} is a recording. Read it without a page.`);
  if ([fromS, toS].some((v) => v !== undefined && !Number.isFinite(v))) return refusal(`from_s/to_s must be numbers of seconds (got from_s=${args.from_s}, to_s=${args.to_s}).`);
  if (fromS !== undefined && fromS < 0) return refusal(`Cannot read ${handle}: from_s (${fromS}) must not be negative.`);
  if (toS !== undefined && toS <= (fromS ?? 0)) return refusal(`Cannot read ${handle}: to_s (${toS}) must be greater than from_s (${fromS ?? 0}).`);
  const source = setup.sources?.[scheme];
  const owned = source?.owns ? await source.owns(id, { conversationId: call.conversationId }) : true;
  if (owned !== true) return refusal(owned);
  const allowed = setup.allow?.({ path: handle, kind: "recording", tool: "read" }) ?? true;
  if (allowed !== true) return refusal(allowed);
  if (!source?.look) return refusal(`${handle} names a browser session's recording, and this run has no recording reviewer to answer a question about it.`);
  const ask = asked(args);
  const window = fromS !== undefined || toS !== undefined ? ` (${fromS ?? 0}s\u2013${toS !== undefined ? `${toS}s` : "end"})` : "";
  const sha256 = createHash("sha256").update(handle).digest("hex");
  const fragment = window ? formatFragment({ t: { from: fromS ?? 0, ...(toS !== undefined ? { to: toS } : {}) } }) : "";
  const record = (model: string, status: "ok" | "failed", body: string, paid?: { readonly costUsd: number; readonly billedBy: string }): LookRecord => ({
    tool: "look", args: { path: handle, ...(ask ? { ask } : {}), ...(fromS !== undefined ? { from_s: fromS } : {}), ...(toS !== undefined ? { to_s: toS } : {}), via: source.via, native: false, model },
    status, facts: { sha256, kind: "recording", fragment, key: lookKey({ sha256, fragment, ask, model }), ...(paid ? { cost_usd: paid.costUsd, provider: paid.billedBy } : {}) }, body,
  });
  try {
    const look = await source.look({ id, ask: ask ?? DESCRIBE_ASK, ...(fromS !== undefined ? { fromS } : {}), ...(toS !== undefined ? { toS } : {}) }, call.signal ?? new AbortController().signal);
    // An answer with no words is a look that failed, as the eyes' is.
    if (!look.text.trim()) throw new Error(`the recording reviewer ${look.model} via ${source.via} returned no text`);
    const paid = { costUsd: look.costUsd, billedBy: look.billedBy ?? source.via };
    const filed = await fileLook(filing, "read", record(look.model, "ok", look.text, paid), { usage: null, ...paid });
    const head = `(recording ${handle}${window} seen for you by ${look.model} via ${source.via}${ask ? ` \u2014 your question: ${ask}` : ""}${filed ? `; look filed at ${filed}` : ""}:)`;
    return { content: [{ type: "text", text: `${head}\n${look.text}` }], details: { path: handle, ...(filed ? { look: filed } : {}), media: { kind: "recording", sessionId: id, ...(ask ? { ask } : {}), ...(fromS !== undefined ? { fromS } : {}), ...(toS !== undefined ? { toS } : {}) } } };
  } catch (error) {
    if (call.signal?.aborted) throw error;
    const reason = firstLine(error);
    const filed = await reportMiss(filing, "read", record("none", "failed", ""), { code: "look_failed", reason });
    return refusal(`Cannot read ${handle}${window}: ${reason}${filed ? ` (look filed at ${filed})` : ""}`);
  }
}

/** The media half of `read`: the result for a file the model looks at or that needs decoding, or a recording by handle;
 *  null when the path reads as plain text (or is not a file), for the host's own read. */
export async function readMedia(env: VisionEnv, raw: ReadArgs, call: CallContext, setup: CallSetup, kinds: ReadKinds = PACKAGE_KINDS): Promise<ToolResult | null> {
  const name = String(raw.path ?? ".");
  const filing: Filing = { conversationId: call.conversationId, label: setup.scope.label, evidence: setup.evidence, onLook: setup.onLook, onMiss: setup.onMiss };
  const handle = handleOf(name, setup.sources);
  if (handle) return readRecording(handle.scheme, handle.id, name.trim(), raw, call, setup, filing);
  const ctx = visionContext(call.signal);
  // The file's first bytes decide its kind, and the arguments and the host's policy are checked on that alone: a read
  // that is refused never holds the file. What is filed for such a read is hashed a chunk at a time.
  const probe = await sniffFile(env, name, kinds.sniff, call.signal);
  if (!probe || (probe.sniffed.ok && probe.sniffed.kind === "text")) return null;
  const streamed = () => sha256Of(env, name, probe.size, call.signal);
  if (!probe.sniffed.ok) return missResult(filing, name, "unknown", await streamed(), probe.sniffed.code, probe.sniffed.reason, raw);
  const { kind } = probe.sniffed;
  if (kind === "unknown") return missResult(filing, name, kind, await streamed(), "unsupported", `its bytes are in no format read takes (first bytes ${probe.sniffed.signature ?? "unknown"})`, raw);
  const paged = kind === "pdf" || kind === "office";
  const args = withoutStrictDefaults(raw, { windowed: kind === "video", paged });
  const [fromS, toS, page] = [num(args.from_s), num(args.to_s), num(args.page)];
  const windowed = fromS !== undefined || toS !== undefined;
  if (windowed && kind !== "video") return refusal(`from_s/to_s apply to video files only; ${name} is not a video. Read it without a window.`);
  if (page !== undefined && !paged) return refusal(`page applies to PDF files and office documents only; ${name} is neither. Read it without a page.`);
  if (windowed && [fromS, toS].some((v) => v !== undefined && !Number.isFinite(v))) return refusal(`from_s/to_s must be numbers of seconds (got from_s=${args.from_s}, to_s=${args.to_s}).`);
  if (windowed && toS !== undefined && toS <= Math.max(0, fromS ?? 0)) return refusal(`Cannot read ${name}: to_s (${toS}) must be greater than from_s (${Math.max(0, fromS ?? 0)}).`);
  if (page !== undefined && !(Number.isInteger(page) && page >= 1)) return refusal(`Cannot read ${name}: page must be an integer of 1 or more (got ${args.page}).`);
  const allowed = setup.allow?.({ path: name, kind, tool: "read" }) ?? true;
  if (allowed !== true) return missResult(filing, name, kind, await streamed(), "refused", allowed, args);
  const reader = kinds.readers[kind];
  if (!reader) return missResult(filing, name, kind, await streamed(), "needs", `no reader for ${kind} files is installed`, args);
  // A source the process may hold is then read once: those bytes are hashed and a private copy of them handed to the
  // reader, so the hash names exactly what was read whatever becomes of the path meanwhile. A file that holds more
  // than it did, or is another kind than its first bytes said, changed between the two looks at it. A larger source
  // is read where it is, and checked afterwards for having changed.
  const held = probe.size <= SOURCE_BYTES_IN_PROCESS ? await holdSource(env, name, call.signal) : "over";
  if (held === null) return null;
  const data = held === "over" ? undefined : held;
  const sniffed = data ? kinds.sniff(data.subarray(0, HEAD_BYTES), name) : probe.sniffed;
  if ((held === "over" && probe.size <= SOURCE_BYTES_IN_PROCESS) || !sniffed.ok || sniffed.kind !== kind) return missResult({ ...filing, evidence: NO_RECEIPT }, name, kind, "", "unreadable", CHANGED, args);
  const size = data ? data.length : probe.size;
  const pixels = kind === "image" ? kinds.sizeOf(data ? data.subarray(0, HEAD_BYTES) : probe.head) : null;
  let hashed: Promise<string> | undefined;
  const sha256 = () => (hashed ??= data ? Promise.resolve(createHash("sha256").update(data).digest("hex")) : streamed());
  const ask = asked(args);
  const temp = await env.createTempDir("pi-vision-read-", ctx);
  if (!temp.ok) throw temp.error;
  let result: KindResult;
  let source: ProviderSource;
  let changed = false;
  try {
    source = { path: data ? `${temp.value}/source${extensionOf(name)}` : name, kind, bytes: size, sha256: await sha256() };
    const request: KindRequest = { source, ...(data ? { data } : {}), name, mimeType: sniffed.mimeType ?? "application/octet-stream", ...(pixels ? { width: pixels.width, height: pixels.height } : {}), ...(ask ? { ask } : {}), ...(page !== undefined ? { page } : {}), ...(fromS !== undefined ? { fromS: Math.max(0, fromS) } : {}), ...(toS !== undefined ? { toS } : {}) };
    // The images a reader makes are fitted for the model that will see them: the lead, or the eyes when the lead takes
    // none. A source read where it is keeps no derivation.
    const limits = !setup.limits.image.native && setup.eyes?.accepts.image ? { ...setup.limits, image: { ...setup.eyes.limits.image, native: false } } : setup.limits;
    try {
      result = await reader(request, { env: data ? holding(env, source.path, data, probe.mtimeMs) : env, signal: call.signal, limits, ...(data ? { deriveDir: setup.scope.deriveDir } : {}), tempDir: temp.value, images: setup.images, providers: setup.providers });
    } catch (error) {
      // A reader that throws on a file it cannot parse gives the model the cause, never a lost call.
      if (call.signal?.aborted) throw error;
      result = { miss: "unreadable", reason: firstLine(error) };
    }
    if (!data) {
      const after = await env.fileInfo(name, ctx);
      changed = !after.ok || after.value.size !== probe.size || after.value.mtimeMs !== probe.mtimeMs;
    }
    // Removed with a context of its own: pi's environments refuse every operation, a removal too, once the call is cancelled.
  } finally { await env.remove(temp.value, { recursive: true, force: true }, visionContext()); }
  // A source that changed while it was read has no hash that names what was read: nothing is filed under the old one.
  if (changed) return missResult({ ...filing, evidence: NO_RECEIPT }, name, kind, source.sha256, "unreadable", CHANGED, args);
  if ("refusal" in result) return refusal(result.refusal);
  if ("miss" in result) return missResult(filing, name, kind, source.sha256, result.miss, result.reason.split(source.path).join(name), args, result.text);
  let content = result.content;
  if (result.text !== undefined && content[0]?.type === "text") {
    let window: string;
    try { window = pageText(result.text, name, num(args.offset), num(args.limit), num(args.char_offset)); } catch (error) { return refusal(`Cannot read ${name}: ${firstLine(error)}`); }
    content = [{ type: "text", text: `${content[0].text}\n\n${window}` }, ...content.slice(1)];
  }
  const original = pixels ? `${pixels.width}x${pixels.height}` : undefined;
  const media: MediaDetails = { kind, path: name, sha256: source.sha256, ...(original ? { original } : {}), ...(ask ? { ask } : {}), ...(page !== undefined ? { page } : {}), ...(fromS !== undefined ? { fromS: Math.max(0, fromS) } : {}), ...(toS !== undefined ? { toS } : {}), ...(result.fit ? { fit: result.fit } : {}), ...result.media };
  return { content, details: { path: name, media, ...(result.document ? { document: result.document } : {}) } };
}

/** `read`'s answer when the host's own callbacks (its scope, eyes or limits) could not set the call up: null for a path
 *  `readMedia` leaves to the host (a plain text file, or not a file, by its first bytes whatever the arguments); for any
 *  other path a `look_failed` miss that the host's `onMiss` hears of and nothing files. */
export async function readWithoutSetup(env: VisionEnv, args: ReadArgs, call: CallContext, error: unknown, host: Pick<CallSetup, "sources" | "onMiss">): Promise<ToolResult | null> {
  const name = String(args.path ?? ".");
  if (!handleOf(name, host.sources)) {
    const probe = await sniffFile(env, name, PACKAGE_KINDS.sniff, call.signal);
    if (!probe || (probe.sniffed.ok && probe.sniffed.kind === "text")) return null;
  }
  const filing: Filing = { conversationId: call.conversationId, label: "", evidence: NO_RECEIPT, onMiss: host.onMiss };
  return missResult(filing, name, "unknown", "", "look_failed", `this host could not set the read up: ${firstLine(error)}`, args);
}

/** Whether a call is the host's plain text read: no handle a source serves, no media argument, and a file that is not
 *  one of the kinds read decodes. The host's read of anything else may file a look or write a derivation. */
export async function readsAsText(env: VisionEnv, args: ReadArgs, call: CallContext, setup: Pick<CallSetup, "sources">, kinds: ReadKinds = PACKAGE_KINDS): Promise<boolean> {
  const name = String(args.path ?? ".");
  if (handleOf(name, setup.sources) || asked(args) || [args.page, args.from_s, args.to_s].some((v) => num(v) !== undefined)) return false;
  const sniffed = (await sniffFile(env, name, kinds.sniff, call.signal))?.sniffed;
  return !sniffed || (sniffed.ok && sniffed.kind === "text");
}
