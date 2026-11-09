// The agent's hand-over of a desktop or a phone to the person: computer_request_handoff, one tool in each of the two
// kinds, under that kind's settings key (desktop.ts and phone.ts list it). It asks the run's hold, through the hands'
// handoff port, with what the person is to do (instruction), how both will know it is done (completion_condition) and
// when the ask expires; the person answers in the run's live view (done, or cancelled), or the ask expires. The call
// waits for that answer, and its words tell the model what happened. A stop or a lost claim ends the wait as an abort.
import type { ToolDef } from "./defs.js";
import { answerOf, type Executor, needsKindWords } from "./hands.js";

export const HANDOFF_TOOL = "computer_request_handoff";
/** How long an ask lasts when the call names no expiry, and the bounds it may name, in seconds. */
export const HANDOFF_DEFAULT_S = 600;
export const HANDOFF_MIN_S = 30;
export const HANDOFF_MAX_S = 3600;

const DESCRIPTION = `Hand the computer to the person for a step you cannot or should not do yourself: a sign-in with their own password, a captcha, a payment, a choice only they can make. Say what they should do (instruction) and how you both will know it is done (completion_condition). You wait until they answer, done or cancelled, or the ask expires (expires_in_s, ${HANDOFF_DEFAULT_S} s when absent). Look at the screen again after it: the person may have changed it.`;

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    instruction: { type: "string", minLength: 1, description: "What the person should do, in words they can follow." },
    completion_condition: { type: "string", minLength: 1, description: "How you and the person will know the step is done: what the screen shows then." },
    expires_in_s: { type: "integer", minimum: HANDOFF_MIN_S, maximum: HANDOFF_MAX_S, description: `How long the person has, in seconds: ${HANDOFF_DEFAULT_S} when absent.` },
  },
  required: ["instruction", "completion_condition"],
};

/** The hand-over's definition in `kind`, under its settings key. Never replayed: a crash after the ask is not asked again. */
export const handoffDef = (kind: "desktop" | "phone"): ToolDef => ({
  name: HANDOFF_TOOL,
  source: "host",
  gateName: `host:${kind}/${HANDOFF_TOOL}`,
  settingsKey: kind,
  description: DESCRIPTION,
  parameters: PARAMETERS,
  replaySafe: false,
});

const words = (outcome: "done" | "cancelled" | "expired", completion: string, seconds: number): string => {
  if (outcome === "done") return `The person says the hand-over is done: ${completion} Look at the screen before you go on: it may have changed.`;
  if (outcome === "cancelled") return "The person cancelled the hand-over. Go on without it, or say why you can't.";
  return `The agent's hand-over expired: the person did not answer within ${seconds} s. Go on without it, or ask again.`;
};

/** The hand-over's run in `kind`: on the hands' handoff port, refused in the kind's words where there is none. */
export const handoffExecutor = (kind: "desktop" | "phone"): Executor => (args, call) =>
  answerOf(call, async () => {
    const given = (typeof args === "object" && args !== null ? args : {}) as { instruction?: unknown; completion_condition?: unknown; expires_in_s?: unknown };
    if (typeof given.instruction !== "string" || given.instruction.trim() === "") throw new Error("instruction is what the person should do, in words");
    if (typeof given.completion_condition !== "string" || given.completion_condition.trim() === "") throw new Error("completion_condition is how you and the person will know the step is done, in words");
    const seconds = given.expires_in_s ?? HANDOFF_DEFAULT_S;
    if (!Number.isSafeInteger(seconds) || (seconds as number) < HANDOFF_MIN_S || (seconds as number) > HANDOFF_MAX_S) throw new Error(`expires_in_s is a whole number of seconds from ${HANDOFF_MIN_S} to ${HANDOFF_MAX_S}`);
    const handoff = call.hands.handoff;
    if (!handoff) throw new Error(needsKindWords(HANDOFF_TOOL, kind));
    const expires_at = new Date(Date.now() + (seconds as number) * 1000).toISOString();
    const { outcome } = await handoff.ask({ instruction: given.instruction, completion_condition: given.completion_condition, expires_at }, call.signal);
    return { text: words(outcome, given.completion_condition, seconds as number) };
  });
