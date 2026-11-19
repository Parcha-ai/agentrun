import { defineHook, type HookContext, type HookEvent } from 'eve/hooks';
import { position } from 'eve/events';
import { reconcile, retireInvalidEvidence } from '../lib/runtime.js';
import { learningState, pendingEvidence, workflowInvocations } from '../lib/state.js';
import { reserveWorkflowInvocation } from '../lib/workflows.js';
import { emptyPendingEvidence, recordHookEvent } from '../lib/pending-evidence.js';

async function recorded(event: HookEvent, ctx: Pick<HookContext, 'position' | 'now' | 'view' | 'session'>) {
  try {
    if (event.type === 'turn.started') retireInvalidEvidence();
    if (event.type === 'call.requested') {
      const record = learningState.get().turns.find(row => row.source.sessionId === ctx.session.id && row.source.turnId === ctx.session.turn.id);
      if (record?.workflowBinding?.toolName === event.data.capability.name && event.data.input !== undefined && !event.data.inputRef) {
        workflowInvocations.update(rows => reserveWorkflowInvocation(rows, record.receipt.run_id, event.data.callId, event.data.input));
      }
    }
    pendingEvidence.update(state => recordHookEvent(state, event, ctx.position, {
      at: ctx.now.toISOString(), committedThrough: position(ctx.view), childSession: Boolean(ctx.session.parent),
    }));
  } catch {
    // A missing hook position cannot silently become complete evidence: the finite merge
    // checks coverage, and a later retry can repair it from the flushed native stream.
    console.warn('AgentRun could not retain this eve event. Completion will wait for recorded history.');
    return;
  }
  if (event.type === 'turn.settled') {
    try {
      await reconcile();
      if (learningState.get().turns.some(row => row.source.turnId === event.data.turnId && row.submitted)) {
        pendingEvidence.update(emptyPendingEvidence);
      }
    }
    catch {
      // Never replace the user's successful native result with a telemetry failure. The pending receipt stays
      // in eve state for retry; AgentRun will not learn until complete evidence has actually been delivered.
      console.warn('AgentRun learning delivery is pending. It will retry on the next turn in this eve session; an abandoned receipt expires without learning.');
    }
  }
}

export default defineHook({ events: {
  '*': recorded,
  // Wildcard subscriptions exclude progress. Keep their factual positions too, so a
  // missing callback is distinguishable from an intentionally omitted model/tool payload.
  'content.delta': recorded,
  'call.input': recorded,
  'call.progress': recorded,
} });
