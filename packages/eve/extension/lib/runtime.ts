import type { DynamicContext } from 'eve';
import { AgentRun, AgentRunRefused, AgentRunUsage } from '@parcha/agentrun-client';
import extension from '../extension.js';
import { beginTurn, learningInstructions, submitTurn, type TurnRecord } from './lifecycle.js';
import { learningState } from './state.js';

/** Retry pending completion on the next admission in this session. No model/tool call is repeated here.
 * A session that never resumes is not a background outbox: its AgentRun receipt eventually expires. */
export async function reconcile(): Promise<void> {
  const { sessions } = await import('eve/server');
  for (const record of learningState.get().turns.filter(row => !row.submitted && !row.expired)) {
    if (record.expiresAt <= Date.now()) {
      learningState.update(state => ({ turns: state.turns.map(row => row.receipt.run_id === record.receipt.run_id ? { ...row, expired: true } : row) }));
      console.warn(`AgentRun run ${record.receipt.run_id} exceeded its evidence lifetime; self-improvement was skipped.`);
      continue;
    }
    try {
      if (await submitTurn(extension.config, record, sessions.attach(record.source.sessionId))) {
        learningState.update(state => ({ turns: state.turns.map(row => row.receipt.run_id === record.receipt.run_id ? { ...row, submitted: true } : row) }));
      }
    } catch (error) {
      if (!(error instanceof AgentRunRefused) || error.code !== 'not_continuable') throw error;
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
    if (state.turns.filter(row => !row.submitted && !row.expired).length >= 8) throw new Error('AgentRun has eight unfinished eve receipts. Reconcile them before starting more turns.');
    const input = turn.input.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n')
      || '[eve task with non-text input; unavailable to the learning checker]';
    const row = await beginTurn(extension.config, {
      sessionId: ctx.session.id, turnId: turn.id, input, model: ctx.model.id,
      startIndex: 0, startedAt: ctx.now.getTime(), complete: turn.input.every(part => part.kind === 'text'),
    });
    learningState.update(current => ({ turns: [...current.turns.filter(item => !item.submitted && !item.expired).slice(-7), row] }));
    return row;
  });
  const pinned = record as TurnRecord;
  if (pinned.baseUrl !== new AgentRun(extension.config).baseUrl || pinned.agentId !== extension.config.agentId || pinned.source.sessionId !== ctx.session.id) {
    throw new AgentRunUsage('The eve session has learning from another AgentRun server or agent. Restore its original mount configuration or start a fresh session.');
  }
  return learningInstructions(pinned);
}
