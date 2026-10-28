import type { EffectError } from './types.ts';

/*
 * The errors a drive throws and catches, by class. Their own module, so a
 * module that only tells them apart (durable-harness/instrumentation/otel)
 * does not load the driver.
 */

/** A committed failure of an effect, rethrown to the harness on replay too. */
export class EffectFailure extends Error {
  constructor(readonly error: EffectError) {
    super(error.message);
    this.name = 'EffectFailure';
  }
}

/** This invocation must stop. The session continues in a later delivery. */
export class Yield extends Error {
  constructor(
    /**
     * - `budget`: out of invocation time; the driver re-enqueues itself.
     * - `contended`: another live driver owns the session; retry later.
     * - `handoff`: the session moved to another lane (see `admit`); whoever
     *   committed the handoff is responsible for waking that lane.
     * - `preempted`: another driver took the session from this one (a
     *   recovery after this drive's delivery lost its lock, or it lost a
     *   handoff race). The drive stops at once and writes nothing more, not
     *   even a release: the new owner resolves whatever this drive left
     *   running.
     * - `parked`: an effect handed its running intent to an owner outside
     *   the drive (a detached sandbox command). The drive detaches from it
     *   and lets go: the owner's report or an owner check wakes the session.
     * - `superseded`: the World's in-band fence refused a write of this
     *   drive (`LogSuperseded`): another drive wrote in-band since this one
     *   loaded, at the same epoch. The drive writes nothing more to the log;
     *   open work of its own goes to a continuation (see `deliverOpen`).
     */
    readonly reason: 'budget' | 'contended' | 'handoff' | 'preempted' | 'parked' | 'superseded',
    readonly delaySeconds = 0
  ) {
    super(`yield: ${reason}`);
    this.name = 'Yield';
  }
}

/**
 * Thrown by an effect's work when it was cut off by something outside it
 * (the sandbox VM it ran on stopped mid-command): committed as an
 * *interrupted* result with the effect's partial output, exactly the shape a
 * crash recovery gives a `replay: 'never'` effect, so harnesses (and models)
 * handle both the same way.
 */
export class EffectInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectInterrupted';
  }
}

/**
 * Thrown by an effect's work after `io.park()` committed: the work goes on
 * outside this drive, so the drive stops here without releasing the intent.
 */
export class Parked extends Error {
  constructor(message = 'parked: the work continues outside this drive') {
    super(message);
    this.name = 'Parked';
  }
}

/** The log changed underneath the harness; rebuild it from the fold. */
export class Restart extends Error {
  constructor(reason: string) {
    super(`restart: ${reason}`);
    this.name = 'Restart';
  }
}

/**
 * The session cannot continue from its log, whoever drives it: a replay
 * that diverges deterministically, a log recorded by an incompatible build.
 * The driver fails the run (`run_failed`, with this message) instead of
 * letting the queue redeliver into the same failure forever.
 */
export class Fatal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fatal';
  }
}
