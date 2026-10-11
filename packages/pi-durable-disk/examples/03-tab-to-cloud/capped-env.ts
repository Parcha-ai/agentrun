// A hard ceiling on how long one command of the agent may run: an improvised command that never returns fails back to the agent,
// which can recover, instead of holding the whole run (and a GPU by the minute). The agent's own `timeout` argument counts only up to
// the ceiling; a command with none gets the ceiling.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export function capTimeouts<E extends ExecutionEnv>(env: E, maxSeconds: number): E {
  if (!(maxSeconds > 0)) return env;
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "exec") {
        return (command: Parameters<E["exec"]>[0], options: Parameters<E["exec"]>[1], context: Parameters<E["exec"]>[2]) =>
          target.exec(command, { ...options, timeout: Math.min(options?.timeout ?? maxSeconds, maxSeconds) }, context);
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
