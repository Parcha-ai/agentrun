// The serve's one cleanup (machines, mounts, tokens, runs) runs however the process ends short of SIGKILL: on SIGINT and
// SIGTERM (exit 130), and on an uncaught exception or an unhandled rejection (exit 1). Every trigger waits for the same
// cleanup, so a second signal (a wrapper forwarding one) never ends the process before it finished. SIGKILL and a host
// crash are bounded only by each machine's hard lifetime (daytona-fleet.ts, ttlMinutes).

export interface ExitProcess {
  on(event: "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection", listener: (reason?: unknown) => void): unknown;
  exit(code: number): void;
}

export function cleanupOnExit(cleanup: () => Promise<void>, proc: ExitProcess, log: (event: string, data?: Record<string, unknown>) => void): void {
  const end = (code: number) =>
    void cleanup().then(
      () => proc.exit(code),
      (error: unknown) => {
        log("cleanup.failed", { error: (error as Error)?.message ?? String(error) });
        proc.exit(code);
      },
    );
  for (const signal of ["SIGINT", "SIGTERM"] as const) proc.on(signal, () => end(130));
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    proc.on(event, (reason) => {
      log("crashed", { event, error: (reason as Error)?.stack?.split("\n").slice(0, 4).join(" | ") ?? String(reason) });
      end(1);
    });
  }
}

/**
 * One cleanup for a process whose resources come up in stages: `startup` (what a failure half way can have made) until
 * `ready(full)` names the whole cleanup. Whichever is current when the first trigger comes runs, once; later triggers
 * wait for that same run. Before it runs it waits for every creation still in flight (`track`), at most `settleMs`: a
 * resource whose create was already sent is listed when it lands (or not at all, when it was refused), so a signal in
 * the middle of a create never leaves it behind.
 */
export function stagedCleanup(
  startup: () => Promise<void>,
  options: { settleMs?: number } = {},
): { cleanup(): Promise<void>; ready(full: () => Promise<void>): void; track<T>(creation: Promise<T>): Promise<T> } {
  let full: (() => Promise<void>) | undefined;
  let running: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const settle = async () => {
    if (pending.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...pending]), new Promise<void>((r) => (timer = setTimeout(r, options.settleMs ?? 30_000)))]);
    clearTimeout(timer);
  };
  return {
    cleanup: () =>
      (running ??= (async () => {
        const stage = full ?? startup;
        await settle();
        await stage();
      })()),
    ready(f) {
      full = f;
    },
    track(creation) {
      pending.add(creation);
      const done = () => void pending.delete(creation);
      creation.then(done, done);
      return creation;
    },
  };
}
