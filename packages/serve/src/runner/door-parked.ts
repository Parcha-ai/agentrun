// A run parked on an MCP call at the proxy door of an earlier version (before #2722 deleted the door), resumed by this one.
// The door answered the CLI's own MCP client the waiting words (waitingText), so the CLI's history holds that call answered
// and its resume never asks about it again: the call's start is on the record parked, and not the bridge's
// (CallStartData.bridge). The claim that resumes such a run answers each such call as that version did: an allow runs it
// once through the loop's host-tool path, a deny is told in its words, then one message, a resume message per call
// (resumeText), the session goes on with. A call parked on this version is held in its CLI's tool bridge and is answered
// there; none of this touches it.
import { STOPPED_WHILE_WAITING } from "../refusal-words.js";
import { type ApprovalPrice, argsPreview, RESUME_GO_ON, resumeText, RESUME_PREFIX } from "../tool-gate.js";
import { type AnswerData, type AskData, type CallEndData, type CallStartData, endedAnswer, KINDS } from "./journal-kinds.js";
import { deniedText } from "./loop-contract.js";
import type { ClaimMcp } from "./mcp-run.js";

/** A call parked at the door, by its catalog name (`mcp:<server>/<tool>`). */
export type DoorCall = { readonly callId: string; readonly tool: string; readonly args: Record<string, unknown> };

/** What the loop lends doorParkedFollowUp: the journal's root entries, its answer for an asked call (an answer entry, the
 *  approve or deny row the claim was handed, or a park when none came: AdapterLoop answerOf), its gate's word on a call
 *  now (a deny set since it asked refuses it), and the call itself through the loop's host-tool path. */
export interface DoorParkedOptions {
  readonly entries: readonly { readonly kind: string; readonly data?: unknown }[];
  answer(call: DoorCall, price: ApprovalPrice | null): Promise<AnswerData | "park">;
  deniedNow(call: DoorCall): Promise<string | undefined>;
  run(call: DoorCall): Promise<{ text: string; isError?: boolean }>;
  /** A parked call refused (the person's deny, or its tool denied since): its end on the run's record, in those words. */
  refused?(call: DoorCall, text: string): Promise<void>;
}

/** The calls an earlier version's MCP door parked on this run (a start parked, not the bridge's), each asked call's answer
 *  acted on once; then the message the session goes on with. "park": a call still waits (the run parks again, its ask
 *  asked again). Undefined: none waits. A call a resume message already answered (on the record) is not answered again. */
export async function doorParkedFollowUp(mcp: Pick<ClaimMcp, "priceOf">, options: DoorParkedOptions): Promise<{ text: string; callIds: string[] } | "park" | undefined> {
  const door = new Set<string>();
  const said = new Set<string>();
  const ended = new Map<string, CallEndData>();
  for (const entry of options.entries) {
    if (entry.kind === KINDS.callStart) {
      const start = entry.data as CallStartData;
      if (start.parked === true && start.bridge !== true) door.add(start.callId);
    } else if (entry.kind === KINDS.callEnd) ended.set((entry.data as CallEndData).callId, entry.data as CallEndData);
    else if (entry.kind === KINDS.message) {
      const text = (entry.data as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.startsWith(RESUME_PREFIX)) said.add(text);
    }
  }
  if (door.size === 0) return undefined;
  const answered = (callId: string) => [...said].some((text) => text.includes(` call ${callId} `));
  const texts: string[] = [];
  const callIds: string[] = [];
  const asked = new Set<string>();
  for (const entry of options.entries) {
    if (entry.kind !== KINDS.ask) continue;
    const ask = entry.data as AskData;
    if (!door.has(ask.callId) || asked.has(ask.callId) || mcp.priceOf(ask.tool) === undefined || answered(ask.callId)) continue;
    asked.add(ask.callId);
    const call: DoorCall = { callId: ask.callId, tool: ask.tool, args: (ask.args ?? {}) as Record<string, unknown> };
    const answer = await options.answer(call, ask.price ?? null);
    if (answer === "park") return "park";
    let result: { text: string; isError?: boolean };
    if (!answer.approved) {
      // A stop's withdrawal (a reopened run's parked call) reads as one; any other deny in its words.
      result = { text: answer.decision === "withdrawn" ? STOPPED_WHILE_WAITING : deniedText(call.tool, answer.note), isError: true };
      await options.refused?.(call, result.text);
    } else {
      const done = ended.get(call.callId);
      const denied = done ? undefined : await options.deniedNow(call);
      // A call that already ended is answered from its end (endedAnswer: a crash-cut one in the kernel's words).
      if (done) result = endedAnswer(call.tool, done);
      else if (denied !== undefined) {
        result = { text: denied, isError: true };
        await options.refused?.(call, denied);
      } else result = await options.run(call);
    }
    texts.push(resumeText({ tool: call.tool, call_id: call.callId }, argsPreview(call.args), answer.approved ? "allow" : "deny", { text: result.text, isError: result.isError === true }));
    callIds.push(call.callId);
  }
  return texts.length ? { text: `${texts.join("\n\n")}\n\n${RESUME_GO_ON}`, callIds } : undefined;
}
