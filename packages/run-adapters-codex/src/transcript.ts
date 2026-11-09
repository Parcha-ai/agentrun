// Codex's transcript rewrite for a resumed run. Written for AgentRun.
//
// Codex's transcript is its thread's rollout, mirrored line by line into the session's records (rollout.ts) and written
// back into an empty CODEX_HOME when its next app-server starts, which resumes the thread from it. A call of the host's
// tools that Codex made and never got an output for is a dangling call. The resume's shared decision settles each one
// through the kernel's tool bridge first, under the call's own id: a call with no intent goes gate, intent, run, result;
// a call with an intent is never run again. This file only writes the outcome the bridge answered into the rollout, as
// Codex records a call's output itself: a `function_call_output` line, after the last; nothing before it changes. Codex
// then resumes the thread from the rewritten rollout, and the call reads as answered.
//
// Only the host's own tools: the session's dynamic tools, which the thread's `session_meta` lists. Codex's own calls
// (code mode's `exec`, its `apply_patch`, a built-in) never went through the bridge, and the harness's own recovery
// answers those.
import { parseLine } from './rollout.js';

/** A call Codex made and never got an output for: its own call id, the host's tool name and the arguments the model gave. */
export type DanglingCall = { readonly callId: string; readonly tool: string; readonly args: unknown };

/** The bridge's answer for a call: its text, and whether it failed (or was interrupted or refused). */
export type CallOutcome = { readonly text: string; readonly isError: boolean };

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The host's tool names the thread was started with (its `session_meta`'s dynamic tools); none with no `session_meta` first. */
function hostTools(lines: readonly string[]): ReadonlySet<string> {
  const first = lines[0] === undefined ? undefined : parseLine(lines[0]);
  const tools = first?.type === 'session_meta' ? first.payload?.dynamic_tools : undefined;
  return new Set(Array.isArray(tools) ? tools.flatMap((tool) => (isPlain(tool) && typeof tool.name === 'string' ? [tool.name] : [])) : []);
}

/** The host's calls Codex made and never got an output for, in the order it made them. */
export function danglingCalls(lines: readonly string[]): DanglingCall[] {
  const tools = hostTools(lines);
  const calls = new Map<string, DanglingCall>();
  for (const raw of lines) {
    const line = parseLine(raw);
    const p = line?.type === 'response_item' ? line.payload : undefined;
    if (!p || typeof p.call_id !== 'string') continue;
    if (p.type === 'function_call' && typeof p.name === 'string' && tools.has(p.name)) {
      let args: unknown = {};
      try {
        args = typeof p.arguments === 'string' && p.arguments ? JSON.parse(p.arguments) : {};
      } catch {
        args = {};
      }
      calls.set(p.call_id, { callId: p.call_id, tool: p.name, args });
    } else if (p.type === 'function_call_output') calls.delete(p.call_id);
  }
  return [...calls.values()];
}

/** `lines` with the dangling call `callId` given `outcome`: one `function_call_output` line after the last, its output the
 *  bridge's text (Codex's rollout keeps no failure flag for a function's output: a failure or refusal is in its words).
 *  Throws when the call does not dangle: an answered call is never rewritten. */
export function settleCall(lines: readonly string[], callId: string, outcome: CallOutcome, now = Date.now()): string[] {
  if (!danglingCalls(lines).some((call) => call.callId === callId)) throw new Error(`Codex's rollout has no call ${callId} of the host's that it made and never got an output for`);
  const output = JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: outcome.text } });
  return [...lines, output];
}
