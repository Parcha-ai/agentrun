// A host driver for a run that changes hosts: the instance of attempt 1 starts on the first host, attempt 2 on the second, attempt 3 on the first again. The place
// (`archilPlace`) takes one driver; this is one driver over several, routing `status`, `stop` and `kill` by the `driver` a handle names. Planned moves are releases, so no
// instance is ever taken over: the next attempt just starts elsewhere.
import type { HostDriver, HostHandle } from "@parcha/pi-durable-disk";

export function rotatingHost(hosts: Readonly<Record<string, HostDriver>>, order: readonly string[]): HostDriver {
  const named = (name: string): HostDriver => {
    const host = hosts[name];
    if (!host) throw new Error(`no host named ${name}`);
    return host;
  };
  const route = (handle: HostHandle) => hosts[handle.driver];
  return {
    kills: "process",
    async start(ref, token, attempt) {
      // The order names its host (`MOVES_HOST`, the runner's choice by the process's number); without one, attempts count from 1 and take the hosts in turn.
      const name = attempt?.env?.MOVES_HOST ?? order[((attempt?.attempt ?? 1) - 1) % order.length]!;
      return named(name).start(ref, token, attempt);
    },
    async status(handle) {
      return route(handle)?.status(handle) ?? "unknown";
    },
    async stop(handle) {
      await route(handle)?.stop(handle);
    },
    async kill(handle) {
      await route(handle)?.kill?.(handle);
    },
    box: (handle) => route(handle)?.box?.(handle) ?? null,
  };
}
