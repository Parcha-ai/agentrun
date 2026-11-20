// The run's side of a write bigger than a channel frame (runner/big-writes.ts has the runner's): a Workspace a run's
// process holds by handle from its runner, with a write of more than one piece handed to the runner's pieced write, which
// pulls the bytes from here a piece at a time. Kept apart from the runner's side so the run's Workspace (archil-claim.ts)
// needs nothing of the runner's.
import type { Workspace } from "./workspace.js";

/** The run's bytes from `offset`, `length` of them: what the runner pulls. */
export type PullPiece = (offset: number, length: number) => Promise<Uint8Array>;
/** A pieced write of `size` bytes at `path`, pulled through `pull`, under `signal`. */
export type WritePieces = (path: string, size: number, pull: PullPiece, signal?: AbortSignal) => Promise<void>;
/** What the runner hands beside a Workspace: its pieced write, and the piece size it pulls (a write of more is pieced). */
export type Pieces = { readonly write: WritePieces; readonly piece: number };

/** `remote` (a runner's Workspace held by handle in a run's process: a plain object of its stand-ins, as the channel
 *  decodes it) with a write of more than `pieces.piece` bytes made through `pieces.write`, under `signal`: the runner pulls
 *  it a piece at a time. A smaller write is one call, as before. No `pieces` (a runner that hands none): `remote` itself. */
export function piecedWorkspace(remote: Workspace, pieces: Pieces | undefined, signal?: AbortSignal): Workspace {
  if (!pieces || typeof pieces.write !== "function" || !Number.isSafeInteger(pieces.piece) || pieces.piece < 1) return remote;
  const { write: writePieces, piece } = pieces;
  return {
    ...remote,
    async write(path: string, data: Uint8Array | string): Promise<void> {
      const over = typeof data === "string" ? Buffer.byteLength(data, "utf8") > piece : data.length > piece;
      if (!over) return remote.write(path, data);
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const pull: PullPiece = async (offset, length) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) throw new RangeError("a piece past the write's bytes");
        return bytes.subarray(offset, offset + length);
      };
      return writePieces(path, bytes.length, pull, signal);
    },
  };
}
