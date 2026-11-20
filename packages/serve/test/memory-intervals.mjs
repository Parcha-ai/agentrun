// The store's computer intervals in memory (store.computerIntervals), as the store writes them: opened once per provider
// and id (a second is ignored), kept, ended only while no end is written; `fail` makes every write throw (a store that
// is down). Its rows are read back by run, in the order they were made.
export function memoryIntervals({ fail = false } = {}) {
  const rows = new Map();
  const key = (provider, providerId) => `${provider}\u0000${providerId}`;
  const refuse = () => {
    if (fail) throw new Error("the store is down");
  };
  return {
    rows,
    async opened(row) {
      refuse();
      if (!rows.has(key(row.provider, row.providerId))) rows.set(key(row.provider, row.providerId), { ...row, kept: false, endedAt: null, bookedMs: 0 });
    },
    async booked(provider, providerId, ms) {
      refuse();
      const row = rows.get(key(provider, providerId));
      if (row && Number.isSafeInteger(ms) && ms > 0) row.bookedMs += ms;
    },
    async kept(provider, providerId) {
      refuse();
      const row = rows.get(key(provider, providerId));
      if (row) row.kept = true;
    },
    async ended(provider, providerId, at) {
      refuse();
      const row = rows.get(key(provider, providerId));
      if (row && row.endedAt === null) row.endedAt = at;
    },
    async forRun(runId) {
      return [...rows.values()].filter((row) => row.runId === runId).sort((a, b) => a.startedAt - b.startedAt).map((row) => ({ ...row }));
    },
  };
}
