// The pipe's wire format, shared by the tab and the pipe. One WebSocket per tab carries JSON text frames. Values that
// JSON cannot carry (undefined, bigint, bytes) travel tagged: every non-primitive is encoded as an object with a `t`
// field, so no value of the agent's own can be mistaken for a tag. Portable: no Node API.
import { ConversationBusy, ReadAfterWrite, StorageRejected } from "@earendil-works/pi-durable";

type Tagged =
  | null
  | boolean
  | number
  | string
  | { t: "u" }
  | { t: "n"; v: string }
  | { t: "b"; v: string }
  | { t: "a"; v: Tagged[] }
  | { t: "o"; v: Record<string, Tagged> };

/** Node's Buffer where there is one (a remote host, the pipe, tests): base64 of a chunk in one native call. */
const NodeBuffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: "base64"): string }; from(data: string, encoding: "base64"): Uint8Array } }).Buffer;

export function toBase64(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes).toString("base64");
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  if (NodeBuffer) return NodeBuffer.from(text, "base64");
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function tag(value: unknown): Tagged {
  if (value === undefined) return { t: "u" };
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return { t: "n", v: String(value) };
  if (value instanceof Uint8Array) return { t: "b", v: toBase64(value) };
  if (Array.isArray(value)) return { t: "a", v: value.map(tag) };
  if (typeof value === "object") {
    const out: Record<string, Tagged> = {};
    for (const [key, item] of Object.entries(value)) Object.defineProperty(out, key, { value: tag(item), enumerable: true, writable: true, configurable: true });
    return { t: "o", v: out };
  }
  throw new TypeError(`cannot send a ${typeof value} over the pipe`);
}

export function untag(value: Tagged): unknown {
  if (value === null || typeof value !== "object") return value;
  switch (value.t) {
    case "u":
      return undefined;
    case "n":
      return BigInt(value.v);
    case "b":
      return fromBase64(value.v);
    case "a":
      return value.v.map(untag);
    case "o": {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.v)) {
        const v = untag(item);
        // A key that held undefined is absent on the far side too, as in a structured clone of a record. Defined, not
        // assigned: a key named `__proto__` stays an own property and never changes the prototype.
        if (v !== undefined) Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
  }
}

/** The Storage methods the pipe dispatches; nothing else is callable. `mintId` is the only one without a Context. */
export const STORAGE_METHODS = [
  "commit",
  "mintId",
  "conversation",
  "scanConversations",
  "entry",
  "findLatestHeadMarker",
  "scanEntries",
  "task",
  "scanTasks",
  "submission",
  "scanSubmissions",
  "submissionByRequest",
  "findDocument",
  "document",
  "scanDocuments",
  "close",
] as const;
export type StorageMethod = (typeof STORAGE_METHODS)[number];

/** A storage error as it crosses the pipe: pi's conflict errors keep their class, so pi can tell them from a failure. */
export type WireError = { name: string; message: string; code?: string; props?: Tagged };

export function errorToWire(error: unknown): WireError {
  if (error instanceof Error) {
    const props: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(error)) if (key !== "cause") props[key] = item;
    const code = (error as { code?: unknown }).code;
    return { name: error.name, message: error.message, ...(typeof code === "string" ? { code } : {}), props: tag(props) };
  }
  return { name: "Error", message: String(error) };
}

/** The pipe lost the run (fenced, taken over, released): the tab's Session must stop, never retry on this attachment. */
export class PipeLostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PipeLostError";
    this.code = code;
  }
}

const CLASSES: Record<string, new (...args: never[]) => Error> = {
  ReadAfterWrite: ReadAfterWrite as never,
  StorageRejected: StorageRejected as never,
  ConversationBusy: ConversationBusy as never,
};

export function errorFromWire(wire: WireError): Error {
  if (wire.name === "PipeLostError") return new PipeLostError(wire.code ?? "LOST", wire.message);
  const Class = CLASSES[wire.name] ?? Error;
  const error = Object.create(Class.prototype) as Error;
  const props = wire.props === undefined ? {} : (untag(wire.props) as Record<string, unknown>);
  Object.assign(error, props, { message: wire.message, name: wire.name });
  if (wire.code !== undefined) (error as { code?: string }).code = wire.code;
  return error;
}

/**
 * The most file content one frame carries, raw: a write-through frame's inline data in total, one upload chunk, one
 * restore chunk. Base64 makes it 4/3 larger, far under the 64 MiB a WebSocket here accepts; and small enough that a
 * frame takes about a second on a 1 MB/s link, so the frames of a long upload keep showing the writer is alive.
 */
export const CHUNK_BYTES = 1024 * 1024;

/**
 * A workspace change as the tab reports it after a tool: a file's whole content, a directory, or a removal. A file's
 * content travels inline (`data`, base64) or, past CHUNK_BYTES, as an upload the tab sent first in `upload` frames
 * (`upload`: its id, size and SHA-256 hex); the pipe puts it in place only when both match.
 */
export type FileChange =
  | { path: string; op: "write"; data: string; mode?: number; mtimeMs?: number }
  | { path: string; op: "write"; upload: { id: string; size: number; sha256: string }; mode?: number; mtimeMs?: number }
  | { path: string; op: "mkdir" }
  | { path: string; op: "delete" };

/** A write as a host hands it to `PipeClient.syncFiles`: the content as bytes (never on the wire as such). */
export type LocalWrite = { path: string; op: "write"; bytes: Uint8Array; mode?: number; mtimeMs?: number };

/** A workspace entry as a viewer sees it (data base64; symlinks carry their target text, never followed). */
export type FileEntry =
  | { path: string; kind: "file"; data: string; mode: number; mtimeMs: number }
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string };

/** A workspace entry in the manifest an attach starts with: a file's size and SHA-256 hex, not its content. */
export type ManifestEntry =
  | { path: string; kind: "file"; size: number; sha256: string; mode: number; mtimeMs: number }
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string };

/** A workspace entry as the writer restores it: a file's content, received in chunks and checked against the manifest. */
export type RestoredEntry =
  | { path: string; kind: "file"; bytes: Uint8Array; mode: number; mtimeMs: number }
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string };

/** SHA-256 hex of `bytes`. Portable: Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  let hex = "";
  for (const b of hash) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * One digest of a workspace: SHA-256 over its sorted lines `file <path> <sha256 of content>` and `directory <path>`
 * (symbolic links are left out: the tab has none). The tab computes it over what the pipe acknowledged last, the pipe
 * over work/ on the disk; equal digests mean the disk holds exactly what the tab showed.
 */
export async function workspaceDigest(lines: string[]): Promise<string> {
  const bytes = new TextEncoder().encode([...lines].sort().join("\n"));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The model endpoint paths (under `/v1/`) a tab may call through the pipe. */
export const MODEL_PATHS = ["responses", "chat/completions"] as const;

/**
 * A place the run can be switched to; the server lists them, the page offers them. `phrase` names it inside a sentence
 * ("your user's browser tab", "a Daytona sandbox"), for the agent's notice of a move. Kinds: the tab; a cloud host
 * that mounts the disk; a remote host that has no disk client and runs the agent through the pipe, as a tab does.
 */
export type Environment = { id: string; label: string; phrase: string; kind: "tab" | "cloud" | "remote"; detail?: string };

/** A move of the run from one host to another (environment.ts's SwitchInfo). */
export type Move = { id: string; from: string; planned: boolean };

/** Where the run is: the badge every page shows. `env` is the environment's id. */
export type Placement =
  | { where: "tab"; tab: string; epoch: number; generation: number; env: string }
  | { where: "cloud"; host: string; generation: number | null; env: string; detail?: string }
  | { where: "moving"; to: string; env: string; switchId?: string; since: number; detail?: string }
  | { where: "parked"; detail?: string };

/** Frames from a tab to the pipe. */
export type TabFrame =
  | { t: "hello"; run: string; token: string; mode: "write" | "view"; tab: string; takeover?: boolean; switchId?: string }
  | { t: "rpc"; id: number; method: StorageMethod; args: Tagged[] }
  | { t: "files"; id: number; changes: FileChange[] }
  /** Part of an upload (base64, at most CHUNK_BYTES raw), in order: `offset` is the bytes sent before it. No answer. */
  | { t: "upload"; id: string; offset: number; data: string }
  /** The restore after `attached` arrived whole and matched its manifest (or why not). */
  | { t: "restored"; ok: true; files: number; bytes: number; ms: number }
  | { t: "restored"; ok: false; error: string }
  | { t: "model"; id: number; path: string; body: Tagged }
  | { t: "model-abort"; id: number }
  | { t: "view"; event: Tagged }
  | { t: "ping"; at: number }
  | { t: "switch"; to: string }
  | { t: "drained"; switchId: string }
  | { t: "switched"; switchId: string }
  | { t: "submit"; text: string; requestId: string }
  | { t: "bye" };

/** Frames from the pipe to a tab. */
export type PipeFrame =
  /** The writer's attachment: work/ as a manifest; the files follow in `restore-chunk` frames, then `restore-end`. */
  | { t: "attached"; epoch: number; generation: number; manifest: ManifestEntry[]; model: string; budget: { used: number; cap: number }; environments: Environment[]; move?: Move }
  /** Part of a manifest file's content (base64, at most CHUNK_BYTES raw), in order. */
  | { t: "restore-chunk"; path: string; offset: number; data: string }
  | { t: "restore-end"; files: number; bytes: number }
  | { t: "viewing"; placement: Placement; files: FileEntry[]; events: Tagged[]; environments: Environment[] }
  | { t: "res"; id: number; ok: true; result: Tagged; ms?: number }
  | { t: "res"; id: number; ok: false; error: WireError }
  | { t: "model-head"; id: number; status: number }
  | { t: "model-chunk"; id: number; data: string }
  | { t: "model-end"; id: number; status: number; error?: string }
  | { t: "event"; event: Tagged }
  | { t: "placement"; placement: Placement }
  | { t: "files-changed"; files: FileEntry[] }
  | { t: "submit"; text: string; requestId: string }
  | { t: "want-snapshot" }
  | { t: "drain"; switchId: string }
  | { t: "run-here"; switchId: string }
  | { t: "switched"; switchId: string; to: string; ms: number }
  | { t: "switch-refused"; to: string; message: string }
  | { t: "lost"; code: string; message: string }
  | { t: "pong"; at: number; now: number }
  | { t: "error"; message: string };

export type { Tagged };
