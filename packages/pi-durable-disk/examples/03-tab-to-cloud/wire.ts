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

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
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

/** A workspace change as the tab reports it after a tool: a file's whole content, a directory, or a removal. */
export type FileChange =
  | { path: string; op: "write"; data: string; mode?: number; mtimeMs?: number }
  | { path: string; op: "mkdir" }
  | { path: string; op: "delete" };

/** A workspace entry as the pipe restores it into a tab (data base64; symlinks carry their target text, never followed). */
export type FileEntry =
  | { path: string; kind: "file"; data: string; mode: number; mtimeMs: number }
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string };

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

/** Where the run is: the badge every page shows. */
export type Placement =
  | { where: "tab"; tab: string; epoch: number; generation: number }
  | { where: "cloud"; host: string; generation: number | null; detail?: string }
  | { where: "moving"; to: "tab" | "cloud"; detail?: string }
  | { where: "parked"; detail?: string };

/** Frames from a tab to the pipe. */
export type TabFrame =
  | { t: "hello"; run: string; token: string; mode: "write" | "view"; tab: string; takeover?: boolean }
  | { t: "rpc"; id: number; method: StorageMethod; args: Tagged[] }
  | { t: "files"; id: number; changes: FileChange[] }
  | { t: "model"; id: number; path: string; body: Tagged }
  | { t: "model-abort"; id: number }
  | { t: "view"; event: Tagged }
  | { t: "ping"; at: number }
  | { t: "cloud"; action: "move" }
  | { t: "submit"; text: string; requestId: string }
  | { t: "bye" };

/** Frames from the pipe to a tab. */
export type PipeFrame =
  | { t: "attached"; epoch: number; generation: number; files: FileEntry[]; model: string; budget: { used: number; cap: number } }
  | { t: "viewing"; placement: Placement; files: FileEntry[]; events: Tagged[] }
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
  | { t: "lost"; code: string; message: string }
  | { t: "pong"; at: number; now: number }
  | { t: "error"; message: string };

export type { Tagged };
