// A call the run's own tools make of another tool of the run, through the same path the harness's calls take: the
// adapter loop sets it around each host tool's call (runner/adapter-loop.ts hosted), so a learned workflow's call node
// that names an MCP tool (learned-workflow.ts runEffect) runs that tool as the loop wrapped it: its flush before the side
// effect, its paid requests booked on the run's one ledger under the call id given, its record on a CLI's timeline, and
// the stop's abort. The gate is the caller's to ask first, with the run's own permissions; the loop says only what card
// a person approved the call it runs inside with (`approved`), so an approval covers what that card named and no more.
import { AsyncLocalStorage } from "node:async_hooks";

/** A host tool's answer, as HostTool.call gives it. */
export type HostAnswer = { text: string; isError?: boolean };

/** What the loop lends a call it runs: an MCP tool of the run by its catalog name (`mcp:<server>/<tool>`), as the loop
 *  wrapped it, or undefined when the run has no such tool; and, when a person approved the call it runs, the arguments
 *  its approval card showed them (the call's ask as journaled: what they saw, never what the gate would show now);
 *  undefined when no person approved it. */
export type HostCalls = {
  readonly mcp: (tool: string) => ((args: unknown, ctx: { callId: string; signal: AbortSignal }) => Promise<HostAnswer>) | undefined;
  readonly approved: Readonly<Record<string, unknown>> | undefined;
};

const calls = new AsyncLocalStorage<HostCalls>();

/** `work` with `lent` as the calls its tool may make. */
export const withHostCalls = <T>(lent: HostCalls, work: () => Promise<T>): Promise<T> => calls.run(lent, work);

/** The calls the tool running now may make; undefined outside a loop's call (a server-side run, a test calling a tool). */
export const hostCalls = (): HostCalls | undefined => calls.getStore();
