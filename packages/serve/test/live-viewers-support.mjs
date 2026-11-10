// The store's live viewers, in memory: the store's LiveViewers (store/store.ts; SqliteStore's on the computer_viewers
// table), for unit tests that need no database (browser-live-store-sqlite.test.mjs runs the same calls on the real one).
// It keeps the contract the real one is held to:
// - put is a runner's, fenced by its claim: a claim whose epoch is not the run's, or whose lease has run out, writes nothing
//   and answers false. It upserts on (run_id, kind, tag), `at` stamped by the store's clock;
// - drop is fenced by the claim's epoch: a stale one drops nothing (and says nothing, as run_live's drop); with no kind the
//   whole run, a kind with no tag that kind's rows, a kind and a tag that one row;
// - of() is the server's: newest first, and only the rows of the run's epoch, under a live claim (claimed_until >= now),
//   written by the run's runner, each carrying its kind. A lapsed or lost claim's rows read as none.
// Rows are kept as given; `received` is every put's input, as the store got it, for a test to search for a token.

/** A fake store holding `liveViewers` alone, with a clock and the calls a test needs to claim a run, let its lease run
 *  out, plant a row and read what the store was given. */
export function fakeLiveViewersStore({ start = 1_000 } = {}) {
  let now = start;
  /** runId -> { epoch, runner, until } */
  const claims = new Map();
  /** runId -> Map(`${kind}:${tag}` -> row) */
  const rows = new Map();
  const received = [];
  const ofRun = (runId) => rows.get(runId) ?? rows.set(runId, new Map()).get(runId);
  const keyOf = (kind, tag) => `${kind}:${tag}`;
  const epochHolds = (claim) => claims.get(claim.runId)?.epoch === claim.epoch;
  const leaseHolds = (claim) => {
    const held = claims.get(claim.runId);
    return held !== undefined && held.epoch === claim.epoch && held.runner === claim.runner && held.until >= now;
  };
  const liveViewers = {
    async put(claim, v) {
      received.push({ claim, v });
      if (!leaseHolds(claim)) return false;
      ofRun(claim.runId).set(keyOf(v.kind, v.tag), { kind: v.kind, tag: v.tag, ...(v.host ? { host: v.host } : {}), port: v.port, id: v.id, sealed: v.sealed, at: now, runner: claim.runner, epoch: claim.epoch });
      return true;
    },
    async drop(claim, kind, tag) {
      if (!epochHolds(claim)) return;
      if (kind === undefined) return void rows.delete(claim.runId);
      const run = rows.get(claim.runId);
      if (!run) return;
      for (const [key, row] of run) if (row.kind === kind && (tag === undefined || row.tag === tag)) run.delete(key);
    },
    async of(runId) {
      const held = claims.get(runId);
      if (!held || held.until < now) return [];
      return [...(rows.get(runId)?.values() ?? [])]
        .filter((row) => row.epoch === held.epoch && row.runner === held.runner)
        .sort((a, b) => b.at - a.at)
        .map(({ epoch: _epoch, ...row }) => row);
    },
  };
  return {
    liveViewers,
    received,
    /** Claims `runId` for `runner` at the next epoch, its lease `leaseMs` from now: a claim as the store hands it. */
    claim(runId, runner = "runner-1", leaseMs = 60_000) {
      const epoch = (claims.get(runId)?.epoch ?? 0) + 1;
      const until = now + leaseMs;
      claims.set(runId, { epoch, runner, until });
      return { runId, runner, epoch, until, from: epoch === 1 ? "queued" : "running" };
    },
    /** The store's clock moves on `ms`. */
    advance(ms) {
      now += ms;
    },
    /** A row written as is, under the run's current claim: what a store holding a damaged row answers. Its kind defaults to
     *  the browser kind (browser-live.ts hands over no other), so a test plants a browser row by naming only its tag. */
    plant(runId, row) {
      const held = claims.get(runId);
      const kind = row.kind ?? "browser";
      ofRun(runId).set(keyOf(kind, String(row.tag)), { at: now, kind, ...row, runner: held?.runner ?? "runner-1", epoch: held?.epoch ?? 0 });
    },
  };
}
