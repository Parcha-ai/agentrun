// A read pool's worker (pool.ts): reads one locator with the registry's reader as parseHome's totals read does, through a
// `seen` of the locator's own records alone, and hands back its sessions, the records it added (mine) and the records it
// asked for, did not hold and never added (missed). parseHome takes the read as its own when no record of either is one
// an earlier locator holds: its `seen` would then have answered every question alike (a record asked for and then added
// is in mine), so the read is the one it would have made.
import { parentPort, workerData } from "node:worker_threads";
import { type Packed, packed, packInto } from "./record-key.js";
import { addNew, addRecord, ownerOf, recordIndex } from "./record-index.js";
import { READERS } from "./readers/index.js";
import type { Locator } from "./reader.js";

export type PoolAsk = { id: number; source: string; locator: Locator };

/** The longest line this worker decodes (pool.ts sets it from the heap cap): a file with a longer one is handed back. */
const { maxLine } = workerData as { maxLine: number };

const buffers = (index: ReturnType<typeof recordIndex>): ArrayBuffer[] =>
  [index.uuids.slots, index.uuids.owners, index.uuids.words, index.others.slots, index.others.owners, index.others.ends, index.others.bytes].map((a) => a.buffer as ArrayBuffer);

parentPort!.on("message", async ({ id, source, locator }: PoolAsk) => {
  const reader = (READERS as Record<string, (typeof READERS)[keyof typeof READERS]>)[source]!;
  const mine = recordIndex(64);
  const missed = recordIndex(64);
  let asked: string | undefined;
  const at = packed();
  // The last record asked for and not held, kept out of missed until the next question: a reader adds most records just
  // after asking for them, and those are in mine.
  let open = false;
  const settle = () => {
    if (open) addRecord(missed, at, 0);
    open = false;
  };
  const pack = (record: string): Packed => {
    if (record === asked) return at;
    settle();
    asked = record;
    return packInto(record, at);
  };
  const seen = {
    has: (record: string) => {
      pack(record);
      if (ownerOf(mine, at) !== -1) return true;
      open = true;
      return false;
    },
    add(record: string) {
      pack(record);
      // open: the last question was of this record, and mine held none (nothing is added to mine in between).
      if (open) addNew(mine, at, 0);
      else addRecord(mine, at, 0);
      open = false;
      return this;
    },
  } as unknown as Set<string>;
  try {
    const result = await reader.read(locator, undefined, { turns: false, totals: true, seen, maxLine });
    settle();
    const counts = result.sessions.flatMap(({ counts }) => (counts ? [counts.model.buffer, counts.values.buffer, counts.has.buffer] : [])) as ArrayBuffer[];
    parentPort!.postMessage({ id, ok: true, sessions: result.sessions, mine, missed }, [...new Set([...buffers(mine), ...buffers(missed), ...counts])]);
  } catch {
    // The read is made again in order by parseHome, which records its failure as its own.
    parentPort!.postMessage({ id, ok: false });
  }
});
