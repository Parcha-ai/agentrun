// The entry kinds of the brain swap (brain.ts writes them, the chat view folds them). Kept apart so the chat view does not pull in the model.
export const BRAIN_LOADING = "brain.loading";
export const BRAIN_SWAP = "brain.swap";
export const BRAIN_FAILED = "brain.failed";
export const BRAIN_MOVE = "brain.move";
