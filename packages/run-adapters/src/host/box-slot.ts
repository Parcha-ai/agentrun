// A session's box slot: one box at a time, and what decides it is empty. Written for AgentRun.
//
// Whatever the isolation (a bwrap box, a cgroup, a provider sandbox), everything inside the box is the agent's: it can
// kill the box's first process, write any line and pick any exit status. So nothing here reads the harness's exit status
// or output to decide anything. The box's record is written durably before anything runs in it (`ahead`, before the
// spawn, and `started`, before its first process is let go). The box is reaped as soon as its process exits, never when
// its stdout closes (a stray holding it would keep that from ever happening), and only the reap's own count says it is
// empty. A session starts one box at a time: a start while its last box is live, being reaped, or not counted empty is
// refused at once, before anything else happens.
//
// This is isolation-agnostic: how a box starts and how it is reaped come in as arguments (box.ts's Box.start and
// Box.reap, or anything with their shape).
import { BoxError, type BoxedChild, type BoxRecord, type BoxRecorder, type Reaped } from "./box.js";

/** `empty`: a reap counted the last box empty, or there was none. `full`: a reap found it not empty, or could not count. */
export type BoxSlotState = "empty" | "live" | "reaping" | "full";

/** What the slot needs of a started box: when it is let go, and when it exited. Its exit status is never read. */
export type SlotChild = Pick<BoxedChild, "ready" | "exited">;

export interface BoxStart<P> {
  /** The box's process, as its start returned it. */
  process: P;
  /** Settles once the box's process exited (or never got going) and the reap that follows gave its verdict: resolves
   *  only when the box holds nothing, else rejects with BoxError box_not_empty. */
  reaped: Promise<void>;
}

export interface BoxSlot<P extends SlotChild> {
  readonly state: BoxSlotState;
  /** Starts the session's next box, synchronously end to end. Refused (BoxError box_busy) unless the slot is empty.
   *  `start` gets the recorder wrapped so the slot keeps the latest record, and calls `ahead` itself before it spawns
   *  anything. A start that throws after `ahead` has its box reaped (the slot shows it), and the error goes up. */
  start(start: (recorder: BoxRecorder) => P, recorder: BoxRecorder): BoxStart<P>;
  /** At open: the record the session's last box left, reaped before anything starts. The slot is empty only if that
   *  reap counts it empty. */
  adopt(previous: BoxRecord): Promise<void>;
}

const busy = (state: BoxSlotState) => new BoxError("box_busy", `box_busy: the session's box is ${state}; a new one starts only once a reap has counted the last one empty`);

/** One session's box slot, reaping with `reap`. */
export function boxSlot<P extends SlotChild>(options: { reap: (record: BoxRecord) => Promise<Reaped> }): BoxSlot<P> {
  let state: BoxSlotState = "empty";
  // The box's latest record: the one its reap is given.
  let latest: BoxRecord | undefined;
  // Each box's start counts one up: a record of an earlier box never lands as this one's.
  let generation = 0;

  const settle = async (record: BoxRecord): Promise<void> => {
    state = "reaping";
    let verdict: Reaped;
    try {
      verdict = await options.reap(record);
    } catch (error) {
      state = "full";
      throw error;
    }
    if (!verdict.empty) {
      state = "full";
      throw new BoxError("box_not_empty", `box_not_empty: the box still holds ${verdict.left} process${verdict.left === 1 ? "" : "es"} after its reap (counted by ${verdict.by}); nothing more starts for its session`, { record, left: verdict.left });
    }
    state = "empty";
    latest = undefined;
  };

  return {
    get state() {
      return state;
    },

    start(start, recorder) {
      if (state !== "empty") throw busy(state);
      state = "live";
      latest = undefined;
      const box = ++generation;
      // Once the box has ended (its reap is on its way), it records nothing more: a late record would replace the next
      // box's on disk. Its reap waits for every record write already in flight, and counts by the newest.
      let ended = false;
      // The seam's order: the ahead record before the spawn, the started one after. A started record with no ahead one
      // before it is refused, so no write can be on its way for a box that was never recorded.
      let recorded = false;
      let writing: Promise<unknown> = Promise.resolve();
      const refused = () => new BoxError("box_record_failed", "box_record_failed: the box has ended; its record is not written");
      const wrapped: BoxRecorder = {
        ahead: (record) => {
          if (ended || box !== generation) throw refused();
          recorder.ahead(record);
          latest = record;
          recorded = true;
        },
        started: (record) => {
          if (!recorded) return Promise.reject(new BoxError("box_record_failed", "box_record_failed: a started record before the box's ahead record; it is not written"));
          if (ended || box !== generation) return Promise.reject(refused());
          const write = recorder.started(record).then(() => {
            if (box === generation) latest = record;
          });
          writing = Promise.all([writing, write.catch(() => {})]);
          return write;
        },
      };
      let boxed: P;
      try {
        boxed = start(wrapped);
      } catch (error) {
        // Recorded, so something may run in it: reaped, and the slot says how that went. Unrecorded: nothing spawned.
        ended = true;
        if (latest !== undefined) writing.then(() => settle(latest!)).catch(() => {});
        else state = "empty";
        throw error;
      }
      if (latest === undefined) {
        // A box that runs and was never recorded cannot be counted: the session starts nothing more.
        state = "full";
        throw new BoxError("box_record_failed", "box_record_failed: the box started without a record of itself");
      }
      // The first of these ends the box: its process exited, or it was never let go. Either way it is reaped, once,
      // by its latest record, and its exit status is not read.
      let once: Promise<void> | undefined;
      const end = () => (once ??= ((ended = true), writing.then(() => settle(latest!))));
      const reaped = Promise.race([boxed.exited, boxed.ready.then(() => boxed.exited)]).then(end, end);
      // Unhandled until the caller asks: a box left full is the caller's to see, not the process's to crash on.
      reaped.catch(() => {});
      return { process: boxed, reaped };
    },

    async adopt(previous) {
      if (state !== "empty") throw busy(state);
      latest = previous;
      await settle(previous);
    },
  };
}
