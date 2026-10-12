// The entry kinds of the brain swap (brain.ts writes them, the chat view folds them). Kept apart so the chat view does not pull in the model.
export const BRAIN_LOADING = "brain.loading";
export const BRAIN_SWAP = "brain.swap";
export const BRAIN_FAILED = "brain.failed";
export const BRAIN_MOVE = "brain.move";
/** The run came home from a browser: written once per check-in, in the root conversation, after the agent runs on the server's copy again. */
export const BRAIN_CHECKIN = "brain.checkin";
/** One routing decision (brain-router.ts): who answers the next message and why. Written in the root conversation before the message, for the decision card. */
export const BRAIN_DECISION = "brain.decision";
