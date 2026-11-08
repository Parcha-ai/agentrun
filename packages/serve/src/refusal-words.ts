// The words a model reads when a call it asked for is refused: one copy, shared by serve's tool gate (tool-gate.ts,
// which re-exports them) and the runner's loops (a denied ask's refusal), so a change of words lands in one place.

/** What every deny tells the model, plainly: the call never left, so nothing was charged for it. */
export const NOT_RUN = "It was not run: nothing was sent and nothing was charged.";
/** What a refusal says instead when an earlier attempt of the call may have been sent: an approved call cut mid-flight,
 *  or a replay-safe call the kernel runs again after a crash. Never a claim that nothing was charged. */
export const RAN_UNKNOWN = "It had started before the deny, and whether it took effect is not known.";
/** A call a person denied, with their reason when they gave one. */
export const refusedText = (tool: string, note?: string, ran: "no" | "unknown" = "no"): string => `The user denied this ${tool} call. ${ran === "no" ? NOT_RUN : RAN_UNKNOWN}${note ? ` Reason: ${note}` : ""}`;
