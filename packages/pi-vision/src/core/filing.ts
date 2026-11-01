import type { EvidenceSink, Filing } from "./evidence.js";
import type { CallContext, CallSetup } from "./host.js";

/** The sink that files nothing: for a read whose source changed while it was read, which no hash names. */
export const NO_RECEIPT: EvidenceSink = { file: async () => null };

export const filingOf = (call: CallContext, setup: CallSetup, evidence: EvidenceSink = setup.evidence): Filing => ({ conversationId: call.conversationId, label: setup.scope.label, evidence, onLook: setup.onLook, onMiss: setup.onMiss });
