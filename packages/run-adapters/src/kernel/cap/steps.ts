// A workflow's steps under the cap: a refused step waits for a raise where it stands, and the run parks once every step
// under way waits. A step is named by its execution path (a model request's, through the provider session of its node's
// conversation), never by the async context that ran it, which a scheduler may share between nodes. A wait is marked
// before it counts: a wait whose mark is not written throws and counts nothing. A refusal for good ends its step as a
// CapStop, kept by path, which a collecting map never takes for an item's failure.
import type { CapRefused } from "./admit.js";
import type { CapMarks } from "./marks.js";

/** A step the cap stopped for good: its path and the refusal. */
export class CapStop extends Error {
  readonly path: string;
  readonly refusal: CapRefused;
  constructor(path: string, refusal: CapRefused) {
    super(refusal.message);
    this.name = "CapStop";
    this.path = path;
    this.refusal = refusal;
  }
}

export interface StepWaits {
  /** A step under way, by its path. */
  working(path: string): void;
  /** A step that ended: it neither works nor waits. */
  done(path: string): void;
  /** The node path a provider session's requests belong to. */
  session(sessionId: string, path: string): void;
  /** A step's path: its own, else its provider session's node. */
  pathOf(at: { path?: string; session?: string }): string;
  /** The step at `path` waits for a raise; its wait mark is written first, and a mark not written counts no wait. */
  wait(path: string, refusal: CapRefused): Promise<boolean>;
  /** Raised: every waiting step works again. */
  resume(): void;
  /** Whether every step under way waits: the run may park. */
  allWaiting(): boolean;
  /** The steps a pause names. */
  waitingFor(): string[];
  /** Ends the step at `path` for good, kept by path. */
  stop(path: string, refusal: CapRefused): CapStop;
  stopped(path: string): CapStop | undefined;
}

export function createStepWaits({ marks, now = Date.now }: { marks?: CapMarks; now?: () => number } = {}): StepWaits {
  const working = new Set<string>();
  const waiting = new Map<string, CapRefused>();
  const sessions = new Map<string, string>();
  const stops = new Map<string, CapStop>();
  /** Each step's generation, and the resumes': a resume, done or stop bumps them, and a wait whose generation moved while
   *  its mark was written counts no wait (it was answered before it began). */
  const generations = new Map<string, number>();
  let resumes = 0;
  const bump = (path: string) => generations.set(path, (generations.get(path) ?? 0) + 1);
  return {
    working: (path) => void working.add(path),
    done: (path) => {
      bump(path);
      working.delete(path);
      waiting.delete(path);
    },
    session: (sessionId, path) => void sessions.set(sessionId, path),
    pathOf: ({ path, session }) => {
      if (path !== undefined) return path;
      const known = session === undefined ? undefined : sessions.get(session);
      if (known === undefined) throw new Error(`no step is known for provider session ${String(session)}: a request must name its node`);
      return known;
    },
    async wait(path, refusal) {
      const [step, resumed] = [generations.get(path) ?? 0, resumes];
      await marks?.write({ kind: "wait", path, at: now() });
      // Resumed, ended or stopped while the mark was written: the wait is answered already, never left behind; the caller
      // reads false and goes on now, rather than blocking on a raise that has already landed.
      if ((generations.get(path) ?? 0) !== step || resumes !== resumed) return false;
      waiting.set(path, refusal);
      return true;
    },
    resume: () => {
      resumes++;
      waiting.clear();
    },
    allWaiting: () => working.size > 0 && [...working].every((path) => waiting.has(path)),
    waitingFor: () => [...waiting.keys()],
    stop(path, refusal) {
      bump(path);
      const stop = new CapStop(path, refusal);
      stops.set(path, stop);
      working.delete(path);
      waiting.delete(path);
      return stop;
    },
    stopped: (path) => stops.get(path),
  };
}
