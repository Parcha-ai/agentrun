// A miss is text the model can act on (`isError: false`), a failed receipt and an event for the host: what could not
// be done, why, and what still works or how to narrow the request. A refusal of the arguments themselves is an error.

import type { MissCode } from "./contract.js";

/** One read or look that could not give the model what it asked for, for the host's rows. */
export type MissEvent = {
  readonly conversationId: string;
  readonly tool: "read" | "look";
  readonly source: string;
  readonly ask?: string;
  readonly code: MissCode;
  /** The first line of the cause, as the model reads it. */
  readonly reason: string;
  /** The eyes' model, when eyes were asked. */
  readonly model?: string;
  readonly receipt: string | null;
};
