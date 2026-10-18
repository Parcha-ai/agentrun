// What a look says of when it ran and under which tool call: the facts a timeline needs to draw the model call a look
// made as a bar under the tool call it ran in. Internal: not exported from the package.

import type { LookRecord } from "./evidence.js";
import type { CallContext } from "./host.js";

/** `toolCallId` when the caller named the tool call, and `startedAt` (epoch milliseconds) when this call began a request
 *  to the model. A look read back from a memo began no request now, so it has no `startedAt`; a look with neither is filed
 *  as it always was. */
export const lookTiming = (call: Pick<CallContext, "toolCallId">, startedAt?: number): Pick<LookRecord["facts"], "toolCallId" | "startedAt"> => ({
  ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
  ...(startedAt !== undefined ? { startedAt } : {}),
});
