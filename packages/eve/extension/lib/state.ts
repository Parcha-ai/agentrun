import { defineState } from 'eve/context';
import type { LearningState } from './lifecycle.js';
import { emptyPendingEvidence } from './pending-evidence.js';
import type { WorkflowInvocation } from './workflows.js';

// eve namespaces this by extension mount and session. No process-global cache or model-visible state.
export const learningState = defineState<LearningState>('agentrun.learning.v1', () => ({ turns: [] }));
// eve's hook sees a logical commit before the workflow step flushes it to the stream.
// Keep that bounded private suffix until the same committed history can be read normally.
export const pendingEvidence = defineState('agentrun.evidence.v1', emptyPendingEvidence);
/** One logical workflow invocation per turn. A replayed completed native call returns the same stored result. */
export const workflowInvocations = defineState<WorkflowInvocation[]>('agentrun.workflows.v1', () => []);
