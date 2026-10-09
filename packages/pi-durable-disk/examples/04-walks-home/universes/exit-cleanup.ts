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
