// The store's live viewers, in memory (browser-live.ts LiveViewers): the slice of the one store that holds each open browser
// session's viewer hand-over, one row per (run, session tag), its token sealed. The store's real `liveViewers` (tl-jobs,
// store/) replaces this fake; until then tests use it. It keeps the contract the real one is held to:
// - put is a runner's, fenced by its claim: a claim whose epoch is not the run's, or whose lease has run out, writes nothing
//   and answers false. It upserts on (run_id, tag), `at` stamped by the store's clock;
// - drop is fenced by the claim's epoch: a stale one drops nothing (and says nothing, as run_live's drop);
// - of() is the server's: newest first, and only the rows of the run's epoch, under a live claim (claimed_until >= now),
//   written by the run's runner. A lapsed or lost claim's rows read as none.
// Rows are kept as given; `received` is every put's input, as the store got it, for a test to search for a token.

/** A fake store holding `liveViewers` alone, with a clock and the calls a test needs to claim a run, let its lease run
 *  out, plant a row and read what the store was given. */
export function fakeLiveViewersStore({ start = 1_000 } = {}) {
  let now = start;
  /** runId -> { epoch, runner, until } */
  const claims = new Map();
  /** runId -> Map(tag -> row) */
  const rows = new Map();
  const received = [];
  const ofRun = (runId) => rows.get(runId) ?? rows.set(runId, new Map()).get(runId);
  const epochHolds = (claim) => claims.get(claim.runId)?.epoch === claim.epoch;
  const leaseHolds = (claim) => {
    const held = claims.get(claim.runId);
    return held !== undefined && held.epoch === claim.epoch && held.runner === claim.runner && held.until >= now;
  };
  const liveViewers = {
    async put(claim, v) {
      received.push({ claim, v });
      if (!leaseHolds(claim)) return false;
      ofRun(claim.runId).set(v.tag, { tag: v.tag, port: v.port, id: v.id, sealed: v.sealed, at: now, runner: claim.runner, epoch: claim.epoch });
      return true;
    },
    async drop(claim, tag) {
      if (!epochHolds(claim)) return;
      if (tag === undefined) rows.delete(claim.runId);
      else rows.get(claim.runId)?.delete(tag);
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
    /** A row written as is, under the run's current claim: what a store holding a damaged row answers. */
    plant(runId, row) {
      const held = claims.get(runId);
      ofRun(runId).set(String(row.tag), { at: now, ...row, runner: held?.runner ?? "runner-1", epoch: held?.epoch ?? 0 });
    },
  };
}
