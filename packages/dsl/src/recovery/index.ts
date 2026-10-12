// Durable recovery for `WorkflowDeps.recovery`, apart from the package root: a host that never resumes a run loads none
// of it. Everything reachable from here stays inside this package, its declared dependencies and Node's builtins, so a
// host on any runtime can use it.
export type { RecoveryBinding, RecoveryEffect, RecoveryJournal, RecoveryNote, RecoveryStore } from "./store.js";
export { openRecovery, recoveryBinding, recoveryBound, routeTaken, workspaceFiles, type RecoveryEffectParams, type RecoveryFiles, type RecoveryOptions, type RecoveryStop } from "./driver.js";
export { withRecovery, type RecoveryAdapters, type RecoveryDriver, type RecoveryNodeParams, type RecoveryStep, type WithRecoveryOptions } from "./with-recovery.js";
export { memoryStore } from "./memory-store.js";
export { fileStore } from "./file-store.js";
export { openJournal, type JournalBackend, type JournalRecord } from "./journal.js";
export { RecoveryError, asRecoveryError, isRecoveryError, runStopOf, runStoppedError } from "./errors.js";
export { bindingDigests, bindingMismatch, LEDGER_FORMAT } from "./binding.js";
export { canonicalHash, canonicalSha256 } from "./canonical-hash.js";
export { callKey, heldCallKey, CALL_KEY_BYTES } from "./call-key.js";
export {
  FROZEN_SNAPSHOT_SCHEMA, validateFrozenSnapshot, openedFrozenSnapshot, serializeFrozenSnapshot, emptyPathFrame,
  frozenStepSessionId, frozenStepId, frozenEffectId, admitFrozenStep, closeFrozenStepAttempt, frozenStop,
  type FrozenSnapshot, type PathFrame, type RouteDecision, type QuestionReceipts, type FrameTag, type StepRecord, type EscalationRow, type FrozenShape,
} from "./frozen-snapshot.js";
export { chainStep, childrenOf, completedIteration, enclosingChains, enclosingIterations, isWithin, nodeAt, pathSegments, topLevelCompletion } from "./execution-path.js";
export { TypedEffectFailure, EffectEnvelopeFailure, classifyEffectFailure } from "./effect-failure.js";
export { effectRetryClass, transportFactOf, type TransportFact } from "./transport-facts.js";
export { buildHandoff, handoffFirstTurn, type Handoff, type HandoffOptions } from "./handoff.js";
export { gatewayIntentOf, inheritableReceipts, inheritableUnknowns, returnedFailure, type InheritedReceipt, type InheritedUnknown } from "./handoff-receipts.js";
export { inputProvenance, judgedRecords, type InputProvenance } from "./handoff-files.js";
export { type InheritedSession, type InheritedEffect, type TranscriptMessage } from "./handoff-digest.js";
