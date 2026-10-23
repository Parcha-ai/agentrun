// D (--trial-tenure): the host's side of pi-agent-learn's workflowAdmitter({ tenure }) contract. `started(run)` is the main
// commit a run was prepared from and its place in the order the pass started runs; `inFlight()` is every run started whose
// curation has not committed. A run leaves at its end: when the curate that takes it returns, or, for one that ends without
// reaching curate (an infrastructure failure, a run past its deadline, an attempt abandoned), when it ends. `events` keeps
// the order of both, for a test or a report.

/** A pass's tenure tracker: `start(run, sha)` as each run is prepared, `end(run, why)` as it ends; the admitter's `started`
 *  and `inFlight`. `sink(fn)` hands every event to `fn` as well (the runner keeps them in <out>/tenure.jsonl). */
export function tenureTracker() {
  const started = new Map();
  const live = new Set();
  const events = [];
  const sinks = [];
  let order = 0;
  const note = (event) => {
    events.push(event);
    for (const fn of sinks) fn(event);
  };
  return {
    events,
    sink(fn) { sinks.push(fn); },
    start(run, sha) {
      started.set(run, { sha, order });
      live.add(run);
      note({ event: 'start', run, sha, order: order++, at: new Date().toISOString() });
    },
    end(run, why) {
      if (!live.delete(run)) return;
      note({ event: 'end', run, why, at: new Date().toISOString() });
    },
    started: (run) => started.get(run),
    inFlight: () => [...live],
  };
}
