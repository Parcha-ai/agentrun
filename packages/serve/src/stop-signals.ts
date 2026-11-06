// A server's stop on SIGINT and SIGTERM (cli.ts). One stop: a terminal's Ctrl-C reaches the server twice within
// milliseconds (its process group, and the npx command passing it on), as a process manager's stop can (systemd signals
// every process of the unit), so a repeat within `repeatMs` is that same stop. A later one is a person who wants out
// now: it stops at once. So does a stop that runs past its deadline, its runs' drain bound and a margin, so a stop
// never hangs. Either way the cut runs resume on the next start, and the line says so.

/** What the stop needs: the server's close, what it waits on, the exit (with its code) and where a line goes. The clock
 *  and the timer default to the process's. */
export type StopDeps = {
  close(): Promise<void>;
  stopping(): { runs: number; boundMs: number };
  done(code: number): void;
  say(line: string): void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
};

/** A repeat within this long is the same stop. */
export const REPEAT_MS = 1_000;
/** How long past its runs' drain bound a stop may take before it stops at once. */
export const DEADLINE_MARGIN_MS = 15_000;

/** The handler for SIGINT and SIGTERM. It exits once: 0 when the close ends, 130 when it stops at once. */
export function stopOnSignals(deps: StopDeps, { repeatMs = REPEAT_MS, marginMs = DEADLINE_MARGIN_MS } = {}): () => void {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => void setTimeout(run, ms).unref());
  let stopAt: number | undefined;
  let over = false;
  const end = (code: number, line?: string) => {
    if (over) return;
    over = true;
    if (line !== undefined) deps.say(line);
    deps.done(code);
  };
  const stopNow = (why: string) => {
    const { runs } = deps.stopping();
    end(130, `${why}; runs resume on the next start${runs > 0 ? ` (${runs} ${runs === 1 ? "was" : "were"} running)` : ""}`);
  };
  return () => {
    if (stopAt !== undefined) {
      if (now() - stopAt >= repeatMs) stopNow("stopping now");
      return;
    }
    stopAt = now();
    setTimer(() => stopNow("the stop passed its deadline, stopping now"), deps.stopping().boundMs + marginMs);
    void deps.close().then(() => end(0));
  };
}
