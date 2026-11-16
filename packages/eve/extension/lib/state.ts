import { defineState } from 'eve/context';
import type { LearningState } from './lifecycle.js';

// eve namespaces this by extension mount and session. No process-global cache or model-visible state.
export const learningState = defineState<LearningState>('agentrun.learning.v1', () => ({ turns: [] }));
