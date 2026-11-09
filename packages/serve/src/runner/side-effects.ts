// The one rule every edge follows before a call that must not run twice (kernel page: "flush before a side effect"):
// its intent in the journal, a flush that makes that intent durable, the call itself (route), then its result. A crash
// before the intent is durable reruns the call from the start; one after it finds the intent and no result, and the
// recovery rule decides: a replay-safe call reruns, any other ends interrupted and is never sent twice. A replay-safe
// call skips the flush, since running it again changes nothing outside the run.
//
// A harness that writes its own intent and result (pi commits its tool task's execute checkpoint before execute(), and
// the result after it) gives no intent or result step: the rule is then the flush, the route and the kernel's hook point
// before the result. Where intent and result are the kernel's to write (a CLI adapter's call), it gives both.

/** One call through the rule. */
export interface SideEffect<R> {
  /** May run again after a crash: it changes nothing outside the run, so no flush is needed before it. */
  readonly replaySafe: boolean;
  /** The kernel's hook point just before the intent is written (the conformance suite crashes here). */
  readonly beforeIntent?: () => Promise<void>;
  /** Writes the call's intent to the run's journal. Omitted where the harness has written it. */
  readonly intent?: () => Promise<void>;
  /** One durable commit for every earlier one (the store's flush). */
  readonly flush: () => Promise<void>;
  /** The call itself. */
  readonly route: () => Promise<R>;
  /** The kernel's hook point after the call returned, just before its result is written. */
  readonly beforeResult?: (result: R) => Promise<void>;
  /** Writes the call's result to the run's journal. Omitted where the harness writes it. */
  readonly result?: (result: R) => Promise<void>;
}

/** Runs `call` through the rule: intent, a flush unless replay-safe, route, result. */
export async function sideEffect<R>(call: SideEffect<R>): Promise<R> {
  await call.beforeIntent?.();
  await call.intent?.();
  if (!call.replaySafe) await call.flush();
  const result = await call.route();
  await call.beforeResult?.(result);
  await call.result?.(result);
  return result;
}
