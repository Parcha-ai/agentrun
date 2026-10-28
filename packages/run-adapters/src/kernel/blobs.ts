// Records too large to keep inline, as content-addressed pieces in the session's own records (kind `kernel.blob`), by
// the names the copied journal calls. A blob is named by its content's sha256, and counts only once all the pieces of
// one write are there and join to text with that hash: a write again under another piece size is a layout of its own,
// never mixed with the first. Written for AgentRun.
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

/** Write `text` as the blob `hash` (its sha256; a caller that has it already passes it), in pieces, durably before it
 *  resolves. A hash that is not the text's is refused. */
export async function writeBlob(world: KernelWorld, runId: string, text: string, options: { hash?: string; pieceChars?: number } = {}): Promise<string> {
  const hash = await sha256Hex(text);
  if (options.hash !== undefined && options.hash !== hash) throw new TypeError("agentrun-adapters: a blob's hash must be its text's sha256");
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

/** Every complete blob of the session, by hash: the pieces of one layout (a hash and its piece count), joined, and
 *  only when they hash to that name. */
export async function readBlobs(world: KernelWorld, runId: string): Promise<Map<string, string>> {
  const layouts = new Map<string, { hash: string; count: number; parts: Map<number, string> }>();
  for (const record of await world.store.read()) {
    if (record.kind !== BLOB_RECORD) continue;
    const { hash, piece, count, text } = record.data as { hash: string; piece: number; count: number; text: string };
    const layout = `${hash}/${count}`;
    const blob = layouts.get(layout) ?? { hash, count, parts: new Map<number, string>() };
    if (!blob.parts.has(piece)) blob.parts.set(piece, text);
    layouts.set(layout, blob);
  }
  const out = new Map<string, string>();
  for (const blob of layouts.values()) {
    if (out.has(blob.hash) || blob.parts.size !== blob.count) continue;
    const text = Array.from({ length: blob.count }, (_, i) => blob.parts.get(i) ?? "").join("");
    if ((await sha256Hex(text)) === blob.hash) out.set(blob.hash, text);
  }
  return out;
}
