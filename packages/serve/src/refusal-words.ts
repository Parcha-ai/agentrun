// The words a model reads when a call it asked for is refused: one copy, shared by serve's tool gate (tool-gate.ts,
// which re-exports them) and the runner's loops (a denied ask's refusal), so a change of words lands in one place.

/** What every deny tells the model, plainly: the call never left, so nothing was charged for it. */
export const NOT_RUN = "It was not run: nothing was sent and nothing was charged.";
/** What a refusal says instead when an earlier attempt of the call may have been sent: an approved call cut mid-flight,
 *  or a replay-safe call the kernel runs again after a crash. Never a claim that nothing was charged. */
export const RAN_UNKNOWN = "It had started before the deny, and whether it took effect is not known.";
/** Where a permission was set (permissionFrom's `from`): the agent's own tool settings, the server's, or the default; or
 *  "unattended": an ask the agent's approvals "never" allowed. */
export type SettingFrom = "agent" | "server" | "default" | "unattended";
/** Where a deny can come from: a setting in a layer, or the default. Never "unattended", which only ever allows. */
export type DenyFrom = Exclude<SettingFrom, "unattended">;
/** Where a deny was set, in words: the place a person changes it. */
export const denyPlace = (from: SettingFrom = "server"): string => (from === "agent" ? "for this agent" : from === "default" ? "by default" : "on this server");
/** The refusal of a call whose tool is set to deny; of one held to another tool's setting (`heldTo`, a shell tool's
 *  bash), naming the setting to change and where it was set (`from`: this agent's settings or this server's). */
export const deniedText = (tool: string, heldTo?: string, from: SettingFrom = "server", ran: "no" | "unknown" = "no"): string => {
  // `ran`: "unknown" for a call an earlier attempt of which may have been sent (an approved call cut mid-flight, or a
  // replay-safe call run again after a crash): the words never claim it wasn't.
  const what = ran === "no" ? NOT_RUN : RAN_UNKNOWN;
  return heldTo && heldTo !== tool ? `Permission denied: ${tool} follows ${heldTo}'s setting, which is deny ${denyPlace(from)}. ${what} Don't retry it.` : `Permission denied: ${tool} is set to deny ${denyPlace(from)}. ${what} Don't retry it.`;
};
/** A workflow call node's tool set to ask: a call node cannot wait for a person's approval, so it is refused unrun
 *  (main's per-run process and the runner's workflow spec, the same words). */
export const callNodeAskText = (tool: string): string => `This ${tool} call needs a person's approval, which a workflow's call node cannot wait for; it was not run.`;
/** A call a person denied, with their reason when they gave one. */
export const refusedText = (tool: string, note?: string, ran: "no" | "unknown" = "no"): string => `The user denied this ${tool} call. ${ran === "no" ? NOT_RUN : RAN_UNKNOWN}${note ? ` Reason: ${note}` : ""}`;
