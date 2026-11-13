// The computer call channel on the runner (../computer-channel.ts has the contract). A runner that holds a run answers its
// `computer_call` rows with this: the run's computer as the loop has it (LoopComputer), the row read as a call
// (channelCallOf), and the call run on the computer behind the person's hold (runChannelCall), which answers what the
// computer said and the call's record. The adapter loop writes that record as a computer.call entry, whose commit takes
// the row with the answer. Another loop, or another door to the channel, uses these three as they are.
import type { ComputerClient, HelloResult } from "@parcha/agentrun-computer";
import { type ComputerCallRecord, callRecordOf, unrecorded } from "../computer-calls.js";
import { type ComputerAnswer, type ComputerCall, PROTOCOL_METHODS } from "../computer-channel.js";
import type { ComputerHold, HeldComputer } from "../workspace/computer-hold.js";
import type { RunComputer } from "../workspace/run-tools.js";
import type { Command } from "./loop-contract.js";

/** The run's computer as the loop drives it: its kind, the client of the computer its claim made and the hello it
 *  connected with, and, on a desktop or a phone, the person's hold on it (workspace/computer-hold.ts). A browser is none:
 *  it speaks CDP, not the protocol. */
export type LoopComputer = {
  readonly kind: "sandbox" | "desktop" | "phone";
  readonly client: ComputerClient;
  readonly hello?: HelloResult;
  readonly hold?: ComputerHold;
};

/** The loop's computer for a claim's (computerForClaim's `computer` and `held`): none for no computer or a browser. */
export function loopComputerOf(computer: RunComputer | undefined, held: HeldComputer | undefined): LoopComputer | undefined {
  if (!computer || computer.kind === "browser") return undefined;
  return {
    kind: computer.kind,
    client: computer.computer.client,
    ...("hello" in computer ? { hello: computer.hello } : {}),
    ...(held && held.kind === computer.kind ? { hold: held.hold } : {}),
  };
}

/** A computer_call row's call, or why it is refused (a row the server wrote is always one; a hand-made one may not be). */
export function channelCallOf(command: Pick<Command, "body">): ComputerCall | { readonly refused: string } {
  const body = (command.body ?? {}) as { method?: unknown; params?: unknown };
  if (typeof body.method !== "string" || !PROTOCOL_METHODS.includes(body.method)) return { refused: `${JSON.stringify(body.method ?? null)} is not a computer protocol method.` };
  // The params come as one JSON text (computer-channel.ts callComputer): an object, or none.
  let params: unknown = {};
  if (body.params !== undefined) {
    try {
      params = typeof body.params === "string" ? JSON.parse(body.params) : undefined;
    } catch {
      params = undefined;
    }
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) return { refused: "The call's params are not a JSON object's text." };
  return { method: body.method, params: params as Record<string, unknown> };
}

/** What one call came to: the computer's answer, the call's record, and when it ended (ms). */
export type ChannelAnswer = { readonly answer: ComputerAnswer; readonly record: ComputerCallRecord; readonly at: number };

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs `call` on `computer` and answers what came of it; never throws. While a person holds the computer the call waits,
 * as the agent's calls do, and counts as in flight once it runs, so a take asked meanwhile waits for it. `signal` bounds
 * the whole of it (the loop's: CALL_MS, and the claim's): a wait or a call it cuts answers `timeout`, a call whose client
 * failed answers `gone`. The call is no tool call's, so it is recorded on none.
 */
export async function runChannelCall(computer: LoopComputer, call: ComputerCall, signal: AbortSignal, now: () => number = Date.now): Promise<ChannelAnswer> {
  const started = performance.now();
  let answer: ComputerAnswer;
  let leave: (() => void) | undefined;
  try {
    leave = computer.hold ? await computer.hold.enter(signal) : undefined;
    answer = (await unrecorded(() => computer.client.call(call.method as never, call.params as never, { signal }))) as ComputerAnswer;
    // A client answers its signal's abort with an error answer of its own (the daemon client's), never a throw: the same
    // `timeout` as a wait the signal cut.
    if (!answer.ok && signal.aborted) answer = { ok: false, error: { code: "timeout", message: `the call did not end in time: ${words(signal.reason)}` } };
  } catch (error) {
    answer = signal.aborted
      ? { ok: false, error: { code: "timeout", message: leave || !computer.hold ? `the call did not end in time: ${words(signal.reason)}` : `a person held the run's computer for the whole of the call's time: ${words(signal.reason)}` } }
      : { ok: false, error: { code: "gone", message: words(error) } };
  } finally {
    leave?.();
  }
  return { answer, record: callRecordOf(call.method, call.params, answer, performance.now() - started), at: now() };
}
