// A CLI's resume, for a call its transcript left dangling (a tool use with no result): the one decision every CLI harness
// shares. A call that never reached its intent (no effect for tool:<callId> among the drive's records: the session's own,
// on the run's journal, never read from the CLI's transcript) goes through the tool bridge, the host's gate first, then
// its intent, the call and its result, all journaled, and only then is it settled into the CLI's transcript, before the
// CLI starts again. So a call a park held (it never started) runs once its approval is in, under the id the model gave
// it. A call that ran to its end before the CLI recorded its result (a read beside a call the gate parked: the park let
// the session go before the CLI wrote the read's result) is settled with the outcome the records hold, read back through
// the bridge's memo: never run again, never asked again. A call that was cut off (an intent with no end, or an end the
// records mark interrupted) is the CLI's own recovery as before: it is never run again here, and a crash after an intent
// lands takes that path, so settling is safe to repeat. A gate that parks again rejects out of here with nothing written
// and nothing settled.
import type { DriveContext } from '../kernel/index.js';
import { type ToolBridge, toolKey } from './tools.js';

/** A tool use the CLI's transcript left with no result: its id, the host tool it calls and its input. */
export interface DanglingCall {
  callId: string;
  tool: string;
  args: unknown;
}

/** A call's result, as it is settled into the CLI's transcript: its text, and whether it is an error. */
export interface CallOutcome {
  text: string;
  isError: boolean;
}

/** The dangling calls that never reached their intent: no effect of theirs in the drive's records. */
export function unstartedCalls(ctx: DriveContext, dangling: readonly DanglingCall[]): DanglingCall[] {
  const effects = ctx.state().effects;
  return dangling.filter((call) => !effects.has(toolKey(call.callId)));
}

/** The dangling calls whose end the drive's records hold: completed, or failed of their own accord (not cut off). */
export function endedCalls(ctx: DriveContext, dangling: readonly DanglingCall[]): DanglingCall[] {
  const effects = ctx.state().effects;
  return dangling.filter((call) => {
    const effect = effects.get(toolKey(call.callId));
    return effect?.status === 'completed' || (effect?.status === 'failed' && effect.error?.interrupted !== true);
  });
}

/**
 * Each dangling call that never reached its intent through `bridge` (gate, intent, call, result), and each one whose end
 * the records hold read back through it (its memo: nothing runs, nothing is asked), then `settle`d into the CLI's
 * transcript, one call after another in the transcript's order. A call cut off is left as it is.
 */
export async function resumeUnstartedCalls(
  ctx: DriveContext,
  bridge: ToolBridge,
  dangling: readonly DanglingCall[],
  settle: (call: DanglingCall, outcome: CallOutcome) => Promise<void>,
): Promise<void> {
  const taken = new Set([...unstartedCalls(ctx, dangling), ...endedCalls(ctx, dangling)]);
  for (const call of dangling) {
    if (!taken.has(call)) continue;
    const result = await bridge.call(call.tool, call.args, call.callId);
    await settle(call, { text: result.text, isError: result.isError });
  }
}
