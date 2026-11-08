// A double of the store's runner part (src/runner/store-port.ts) and faux loops, for the runner's reds until module A's
// SqliteStore lands; then the reds open the real store and keep these loops. The double keeps A's rules: a claim moves
// the epoch, every write under a lower epoch is refused (Fenced), a command for a final run is refused in the insert
// (RunFinal), and a journal commit's staged takes land with it or not at all (CommandTaken). Times are ms since the
// epoch, as A's are.

export class Fenced extends Error {
  name = "Fenced";
}
export class RunFinal extends Error {
  name = "RunFinal";
}
export class CommandTaken extends Error {
  name = "CommandTaken";
}

const FINAL = new Set(["ended", "stopped", "failed"]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a truthy value, or fails after `ms` naming `what`. */
export async function until(check, what, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(5);
  }
}

export function storeDouble({ now = () => Date.now() } = {}) {
  const rows = new Map();
  const commands = [];
  /** Every journal commit that landed: { runId, epoch, runner, at, entry }. */
  const commits = [];
  /** Every claim that landed: { runId, runner, epoch, at, until (ms) }. */
  const claims = [];
  /** Runner names whose renew fails as a busy database would (the store unreachable for them). */
  const blockRenew = new Set();
  let order = 0;
  let commandId = 0;
  let flushes = 0;
  /** The order of flushes, releases and end commits: "flush", "release run-1", "end run-1". */
  const ops = [];

  const row = (runId) => {
    const run = rows.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    return run;
  };
  const fence = (claim) => {
    const run = row(claim.runId);
    if (run.epoch !== claim.epoch) throw new Fenced(`run ${claim.runId}: epoch ${claim.epoch} is not ${run.epoch}`);
    return run;
  };
  const untaken = (runId) => commands.some((command) => command.runId === runId && command.takenAt === null);
  const iso = (ms) => new Date(ms).toISOString();
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const store = {
    commits,
    claims,
    commandRows: commands,
    blockRenew,
    flushes: () => flushes,
    ops,
    /** Another runner's claim, made behind this test's runners: the epoch moves and the old claim is fenced. */
    runsTableBump(runId, leaseMs = 60_000) {
      const run = row(runId);
      run.epoch += 1;
      run.runner = "runner-z";
      run.claimedUntil = now() + leaseMs;
      return { epoch: run.epoch, bumpedAt: now() };
    },
    runs: {
      async create(id) {
        rows.set(id, { id, state: "queued", epoch: 0, runner: null, claimedUntil: null, wakeAt: null, order: order++ });
      },
      async get(id) {
        const run = rows.get(id);
        return run && { ...run };
      },
      async claimable({ limit }) {
        await tick();
        const at = now();
        return [...rows.values()]
          .filter(
            (run) =>
              run.state === "queued" ||
              (run.state === "parked" && run.runner === null && (untaken(run.id) || (run.wakeAt !== null && run.wakeAt <= at))) ||
              (run.state === "running" && (run.runner === null || run.claimedUntil < at)),
          )
          .sort((a, b) => a.order - b.order)
          .slice(0, limit)
          .map((run) => run.id);
      },
      async update(claim, patch) {
        await tick();
        Object.assign(fence(claim), patch);
      },
    },
    async claim(runId, runner, { leaseMs }) {
      await tick();
      const run = rows.get(runId);
      if (!run || FINAL.has(run.state)) return null;
      const at = now();
      if (run.runner !== null && run.claimedUntil >= at) return null;
      run.epoch += 1;
      run.runner = runner;
      run.claimedUntil = at + leaseMs;
      run.wakeAt = null;
      run.state = "running";
      claims.push({ runId, runner, epoch: run.epoch, at, until: run.claimedUntil });
      return { runId, runner, epoch: run.epoch, until: run.claimedUntil };
    },
    async renew(claim, { leaseMs }) {
      await tick();
      if (blockRenew.has(claim.runner)) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const run = fence(claim);
      run.claimedUntil = now() + leaseMs;
      return { ...claim, until: run.claimedUntil };
    },
    async release(claim, options = {}) {
      await tick();
      const run = fence(claim);
      run.runner = null;
      run.claimedUntil = null;
      run.wakeAt = options.wakeAt ?? null;
      ops.push(`release ${claim.runId}`);
    },
    journal(claim) {
      let staged = { take: [], run: null };
      return {
        stage({ take = [], run } = {}) {
          staged.take.push(...take);
          if (run) staged.run = { ...staged.run, ...run };
        },
        async commit(entry) {
          await tick();
          const run = fence(claim);
          const takes = staged.take.map((id) => commands.find((command) => command.id === id && command.runId === claim.runId));
          const taken = takes.findIndex((command) => !command || command.takenAt !== null);
          if (taken !== -1) throw new CommandTaken(`run ${claim.runId}: command ${staged.take[taken]}`);
          const at = now();
          for (const command of takes) command.takenAt = iso(at);
          if (staged.run) Object.assign(run, staged.run);
          if (staged.run && staged.run.state !== "running") ops.push(`${staged.run.state} ${claim.runId}`);
          staged = { take: [], run: null };
          commits.push({ runId: claim.runId, epoch: claim.epoch, runner: claim.runner, at, entry });
        },
      };
    },
    async flush() {
      await tick();
      flushes += 1;
      ops.push("flush");
    },
    async command(runId, { kind, body = {} }) {
      await tick();
      if (FINAL.has(row(runId).state)) throw new RunFinal(`run ${runId} is ${row(runId).state}`);
      const command = { id: ++commandId, runId, kind, body, createdAt: iso(now()), takenAt: null, refused: null };
      commands.push(command);
      return { ...command };
    },
    async commands(runId, after) {
      await tick();
      return commands.filter((command) => command.runId === runId && command.id > after).map((command) => ({ ...command }));
    },
    async take(claim, commandId, _outcome, reason) {
      await tick();
      fence(claim);
      const command = commands.find((c) => c.id === commandId && c.runId === claim.runId);
      if (!command || command.takenAt !== null) throw new CommandTaken(`run ${claim.runId}: command ${commandId}`);
      command.takenAt = iso(now());
      command.refused = reason;
    },
  };
  return store;
}

/**
 * Faux loops: each start() runs `turns` turns of `turnMs`, one journal commit per turn, and ends with the run's state in
 * its last commit. A steer, approve or raise handed to it is staged as a take in its next commit; a stop row ends it as
 * stopped with the take in that commit. `park: true` parks the first start (state parked in its last commit) and the
 * next start ends it. `stubborn: true` ignores stop() and the signal and keeps committing, so only the runner's own
 * fence keeps its writes out. Every loop made is in `loops`, with its received commands and its commit errors.
 */
export function fauxLoops({ turns = 3, turnMs = 10, park = false, stubborn = false, work } = {}) {
  const loops = [];
  const parkedRuns = new Set();
  const createLoop = (deps) => {
    let stopReason = null;
    let wake = () => {};
    let done;
    const ended = new Promise((resolve) => (done = resolve));
    const loop = {
      deps,
      claim: null,
      received: [],
      pending: [],
      stopCalls: [],
      commitErrors: [],
      journal: null,
      /** Ends a stubborn loop at its next turn (a test's cleanup). */
      halted: false,
      /** One more commit now, as a late write of a loop whose runner stopped answering. */
      async commitNow(entry = { kind: "late" }) {
        await loop.journal.commit(entry);
      },
      async start(claim) {
        loop.claim = claim;
        const journal = deps.journal(claim);
        loop.journal = journal;
        try {
          if (park && !parkedRuns.has(claim.runId)) {
            parkedRuns.add(claim.runId);
            journal.stage({ run: { state: "parked" } });
            await journal.commit({ kind: "parked" });
            return { state: "parked" };
          }
          for (let turn = 0; stubborn ? !loop.halted : turn < turns; turn++) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, turnMs);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
              if (!stubborn) deps.signal.addEventListener("abort", wake, { once: true });
            });
            if (work) work();
            if (stopReason && !stubborn) {
              if (stopReason.kind === "command") {
                journal.stage({ run: { state: "stopped" }, take: [stopReason.commandId] });
                await journal.commit({ kind: "stopped" });
                return { state: "stopped" };
              }
              return { state: "interrupted" };
            }
            journal.stage({ take: loop.pending.splice(0).map((command) => command.id) });
            try {
              await journal.commit({ kind: "turn", turn });
            } catch (error) {
              loop.commitErrors.push({ at: Date.now(), name: error.name });
              if (!stubborn) throw error;
            }
          }
          journal.stage({ run: { state: "ended" }, take: loop.pending.splice(0).map((command) => command.id) });
          await journal.commit({ kind: "end" });
          return { state: "ended" };
        } finally {
          done();
        }
      },
      async command(command) {
        loop.received.push({ ...command, at: Date.now() });
        loop.pending.push(command);
        return { taken: true };
      },
      async stop(reason) {
        loop.stopCalls.push({ ...reason, at: Date.now() });
        stopReason = reason;
        wake();
        if (!stubborn) await ended;
      },
    };
    loops.push(loop);
    return loop;
  };
  return { loops, createLoop };
}
