// Records too large to keep inline, as content-addressed pieces in the session's own records (kind `kernel.blob`), by
// the names the copied journal calls. A blob counts only once all its pieces are written. Written for AgentRun.
import { createHash } from "node:crypto";
import { SessionFenced } from "../errors.js";
import { Restart } from "./errors.js";
import type { KernelWorld } from "./types.js";

export const BLOB_RECORD = "kernel.blob";
/** Characters per piece. */
export const BLOB_PIECE_CHARS = 2 * 1024 * 1024;
/** Where a session's blobs are, for messages: the session's own records. */
export const blobStreamName = (runId: string) => `${runId} (${BLOB_RECORD} records)`;

export async function sha256Hex(content: string): Promise<string> {
  return createHash("sha256").update(content).digest("hex");
}

/** Write `text` as the blob `hash`, in pieces, durably before it resolves. */
export async function writeBlob(world: KernelWorld, runId: string, text: string, options: { hash?: string; pieceChars?: number } = {}): Promise<string> {
  const hash = options.hash ?? (await sha256Hex(text));
  const size = options.pieceChars ?? BLOB_PIECE_CHARS;
  const count = Math.max(1, Math.ceil(text.length / size));
  const records = Array.from({ length: count }, (_, piece) => ({ kind: BLOB_RECORD, data: { hash, piece, count, text: text.slice(piece * size, (piece + 1) * size) } }));
  try {
    await world.store.append(records);
  } catch (error) {
    // A newer drive holds the session, as for an effect's own writes.
    if (error instanceof SessionFenced) throw new Restart(`agentrun-adapters: ${error.message}`);
    throw error;
  }
  return hash;
}

/** Every complete blob of the session, by hash. */
export async function readBlobs(world: KernelWorld, runId: string): Promise<Map<string, string>> {
  const pieces = new Map<string, { count: number; parts: Map<number, string> }>();
  for (const record of await world.store.read()) {
    if (record.kind !== BLOB_RECORD) continue;
    const { hash, piece, count, text } = record.data as { hash: string; piece: number; count: number; text: string };
    const blob = pieces.get(hash) ?? { count, parts: new Map() };
    blob.parts.set(piece, text);
    pieces.set(hash, blob);
  }
  const out = new Map<string, string>();
  for (const [hash, blob] of pieces) {
    if (blob.parts.size !== blob.count) continue;
    out.set(hash, Array.from({ length: blob.count }, (_, i) => blob.parts.get(i) ?? "").join(""));
  }
  return out;
}
