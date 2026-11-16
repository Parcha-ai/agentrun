import { defineHook } from 'eve/hooks';
import { reconcile } from '../lib/runtime.js';

export default defineHook({ events: {
  async 'turn.settled'() {
    try { await reconcile(); }
    catch {
      // Never replace the user's successful native result with a telemetry failure. The pending receipt stays
      // in eve state for retry; AgentRun will not learn until complete evidence has actually been delivered.
      console.warn('AgentRun learning delivery is pending. It will retry on the next turn in this eve session; an abandoned receipt expires without learning.');
    }
  },
} });
