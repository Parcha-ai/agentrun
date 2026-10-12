// The VM beat's life, apart from Modal and the disk so it can be tested: the host follows the VM's events to a terminal
// one, a run that did not end in `done` fails, the beat's start and finish are marked on the run's disk, and anything
// that fails after the VM started cleans up before it throws.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Log = (event: string, data?: Record<string, unknown>) => void;

/** Reads the VM's events file until `done` or `vm.error`, or the deadline; `ended` is undefined when none came. */
export async function followEvents(read: () => Promise<string>, log: Log, o: { deadlineMs: number; pollMs: number }): Promise<{ ended: string | undefined; out: string }> {
  let seen = 0;
  let out = "";
  let ended: string | undefined;
  const deadline = Date.now() + o.deadlineMs;
  while (!ended && Date.now() < deadline) {
    const lines = (await read()).split("\n").filter(Boolean);
    for (const line of lines.slice(seen)) {
      const e = JSON.parse(line) as { event: string; out?: string };
      log(`vm:${e.event}`, e);
      if (e.event === "vm.open" && e.out) out = e.out;
      if (e.event === "done" || e.event === "vm.error") ended = e.event;
    }
    seen = lines.length;
    if (!ended) await new Promise((resolve) => setTimeout(resolve, o.pollMs));
  }
  return { ended, out };
}

/** A run whose beat did not end in `done` is not a result. */
export function requireDone(ended: string | undefined, deadlineMs: number): void {
  if (ended === "done") return;
  throw new Error(ended ? "the VM session failed (see vm:vm.error above)" : `the VM session did not finish within ${Math.round(deadlineMs / 60_000)} minutes`);
}

/** The beat's marks in its output directory on the run's disk: started when it begins, finished when it is done. */
export function beatMarks(out: string) {
  const mark = (name: string) => {
    mkdirSync(out, { recursive: true });
    appendFileSync(join(out, name), `${new Date().toISOString()}\n`);
  };
  return {
    state: (): "new" | "interrupted" | "finished" => (existsSync(join(out, "timeline.finished")) ? "finished" : existsSync(join(out, "timeline.started")) ? "interrupted" : "new"),
    started: () => mark("timeline.started"),
    finished: () => mark("timeline.finished"),
  };
}

/** `work` after something that must be undone if it fails: on a throw, `close` runs first, then the error goes on. */
export async function cleanOnFailure<T>(close: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await close();
    throw error;
  }
}
