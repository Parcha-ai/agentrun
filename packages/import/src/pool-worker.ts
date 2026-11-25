// A read pool's worker (pool.ts): reads one locator with the registry's reader as parseHome's totals read does, through a
// `seen` of the locator's own records alone, and hands back its sessions, the records it added (mine) and the records it
// asked for, did not hold and never added (missed). parseHome takes the read as its own when no record of either is one
// an earlier locator holds: its `seen` would then have answered every question alike (a record asked for and then added
// is in mine), so the read is the one it would have made.
import { parentPort } from "node:worker_threads";
import { packed, packInto } from "./record-key.js";
import { addRecord, notIn, ownerOf, recordIndex } from "./record-index.js";
import { DROPS_CURSOR, type InternalReadOptions } from "./internal.js";
import { READERS } from "./readers/index.js";
import type { Locator } from "./reader.js";

export type PoolAsk = { id: number; source: string; locator: Locator };

const buffers = (index: ReturnType<typeof recordIndex>): ArrayBuffer[] =>
  [index.uuids.slots, index.uuids.owners, index.uuids.words, index.others.slots, index.others.owners, index.others.ends, index.others.bytes].map((a) => a.buffer as ArrayBuffer);

parentPort!.on("message", async ({ id, source, locator }: PoolAsk) => {
  const reader = (READERS as Record<string, (typeof READERS)[keyof typeof READERS]>)[source]!;
  const mine = recordIndex(64);
  // Every record asked for while mine did not hold it; the ones added after are taken out once the read ends.
  const asked = recordIndex(64);
  const at = packed();
  const seen = {
    has: (record: string) => {
      if (ownerOf(mine, packInto(record, at)) !== -1) return true;
      addRecord(asked, at, 0);
      return false;
    },
    add(record: string) {
      addRecord(mine, packInto(record, at), 0);
      return this;
    },
  } as unknown as Set<string>;
  try {
    // The cursor is never sent back: the read makes no copy for it.
    const options: InternalReadOptions = { turns: false, totals: true, seen, [DROPS_CURSOR]: true };
    const result = await reader.read(locator, undefined, options);
    const missed = notIn(asked, mine);
    const counts = result.sessions.flatMap(({ counts }) => (counts ? [counts.model.buffer, counts.values.buffer, counts.has.buffer] : [])) as ArrayBuffer[];
    parentPort!.postMessage({ id, ok: true, sessions: result.sessions, mine, missed }, [...new Set([...buffers(mine), ...buffers(missed), ...counts])]);
  } catch {
    // The read is made again in order by parseHome, which records its failure as its own.
    parentPort!.postMessage({ id, ok: false });
  }
});
