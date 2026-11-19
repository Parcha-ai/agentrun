import type { DynamicContext } from 'eve';
import { AgentRun, AgentRunRefused, AgentRunUsage } from '@parcha/agentrun-client';
import extension from '../extension.js';
import { beginTurn, learningInstructions, submitTurn, type TurnRecord } from './lifecycle.js';
import { learningState, pendingEvidence } from './state.js';
import { withPendingEvidence } from './pending-evidence.js';

/** Irrecoverably bounded or conflicting hook evidence belongs to its turn, never every future native task. */
export function retireInvalidEvidence(): void {
  const pending = pendingEvidence.get();
  if (!pending.invalid) return;
  learningState.update(state => ({ turns: state.turns.map(record =>
    !record.submitted && !record.expired && (!pending.turn || pending.turn.id === record.source.turnId)
      ? { ...record, expired: true } : record) }));
}

/** Retry pending completion on the next admission in this session. No model/tool call is repeated here.
 * A session that never resumes is not a background outbox: its AgentRun receipt eventually expires. */
export async function reconcile(): Promise<void> {
  retireInvalidEvidence();
  const { sessions } = await import('eve/server');
  for (const record of learningState.get().turns.filter(row => !row.submitted && !row.expired)) {
    if (record.expiresAt <= Date.now()) {
      learningState.update(state => ({ turns: state.turns.map(row => row.receipt.run_id === record.receipt.run_id ? { ...row, expired: true } : row) }));
      console.warn(`AgentRun run ${record.receipt.run_id} exceeded its evidence lifetime; self-improvement was skipped.`);
      continue;
    }
    try {
      if (await submitTurn(extension.config, record, withPendingEvidence(sessions.attach(record.source.sessionId), pendingEvidence.get(), record.source.turnId), saved => {
        learningState.update(state => ({ turns: state.turns.map(row => row.receipt.run_id === saved.receipt.run_id ? { ...saved } : row) }));
      })) {
        learningState.update(state => ({ turns: state.turns.map(row => row.receipt.run_id === record.receipt.run_id ? { ...row, submitted: true } : row) }));
      }
    } catch (error) {
      if (!(error instanceof AgentRunRefused) || error.code !== 'not_continuable') {
        // Delivery belongs to this old receipt. Never fail an unrelated native turn because telemetry is unavailable.
        console.warn(`AgentRun run ${record.receipt.run_id} still has pending evidence; new native turns can continue.`);
        continue;
      }
      // The server closed/expired this receipt. Do not invent a completion or keep blocking new eve turns.
      learningState.update(state => ({ turns: state.turns.map(row => row.receipt.run_id === record.receipt.run_id ? { ...row, expired: true } : row) }));
      console.warn(`AgentRun run ${record.receipt.run_id} no longer accepts evidence; self-improvement was skipped.`);
    }
  }
}

export async function instructionsFor(ctx: DynamicContext): Promise<string> {
  const turn = ctx.turn;
  if (!turn || turn.status === 'settled') return '';
  // Memo avoids a network round trip on every model call. The idempotency key, NOT the memo, prevents duplicate
  // admission when eve discards a memo after a deploy or a step failed before its state was checkpointed.
  const record = await ctx.memo(['agentrun', turn.id], async () => {
    await reconcile();
    const state = learningState.get();
    const found = state.turns.find(row => row.source.turnId === turn.id);
    if (found) return found;
    if (state.turns.filter(row => !row.submitted && !row.expired).length >= 8) {
      console.warn('AgentRun has eight pending receipts; this native turn continues without new learning evidence.');
      return null;
    }
    const window = pendingEvidence.get().turn;
    if (!window || window.id !== turn.id) {
      console.warn('AgentRun did not observe this turn starting; this native turn continues without new learning evidence.');
      return null;
    }
    const input = turn.input.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n')
      || '[eve task with non-text input; unavailable to the learning checker]';
    const row = await beginTurn(extension.config, {
      sessionId: ctx.session.id, turnId: turn.id, input, model: ctx.model.id,
      startIndex: window.startIndex, startedAt: ctx.now.getTime(),
      complete: window.complete && !ctx.session.parent && turn.input.every(part => part.kind === 'text'),
    });
    learningState.update(current => ({ turns: [...current.turns.filter(item => !item.submitted && !item.expired && item.source.turnId !== row.source.turnId).slice(-7), row] }));
    return row;
  });
  if (!record) return '';
  const pinned = record as TurnRecord;
  if (pinned.baseUrl !== new AgentRun(extension.config).baseUrl || pinned.agentId !== extension.config.agentId || pinned.source.sessionId !== ctx.session.id) {
    throw new AgentRunUsage('The eve session has learning from another AgentRun server or agent. Restore its original mount configuration or start a fresh session.');
  }
  return learningInstructions(pinned, extension.config.workflows);
}
