import { RecoveryError } from "./errors.js";
import { openJournal, type JournalRecord } from "./journal.js";
import type { RecoveryStore } from "./store.js";

/** A store that keeps one run's journal in this process: for tests, and for a host that wants the driver's rules
 *  within one process and no resume after it. */
export function memoryStore(): RecoveryStore {
  let record: JournalRecord | undefined;
  let owned = false;
  return {
    open: (bound) => openJournal({
      async acquire() {
        if (owned) throw new RecoveryError("Run already has a live owner");
        owned = true;
        return async () => { owned = false; };
      },
      read: async () => record && structuredClone(record),
      write: async (next) => { record = structuredClone(next); },
    }, bound),
  };
}
