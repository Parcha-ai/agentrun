import { defineDynamic, defineTool } from 'eve/tools';
import { z } from 'zod';
import extension from '../extension.js';
import { instructionsFor } from '../lib/runtime.js';
import { learningState, workflowInvocations } from '../lib/state.js';
import { executeLearnedWorkflow, workflowInvocation } from '../lib/workflows.js';

const tool = defineTool({
  description: 'Execute one compiled AgentRun workflow that fits the current task with its exact name and fresh input using the original read-only tools. Return the completed textual result verbatim. At most one workflow invocation per turn; never retry a failed or uncertain invocation.',
  inputSchema: z.object({ name: z.string().min(1).max(256), input: z.record(z.string(), z.unknown()) }).strict(),
  availableInSubagents: false,
  async execute(input, ctx) {
    const record = learningState.get().turns.find(row => row.source.turnId === ctx.session.turn.id && row.source.sessionId === ctx.session.id);
    if (!record || record.workflowBinding?.toolName !== ctx.toolName) throw new Error('This native eve turn has no matching AgentRun workflow binding.');
    const prior = workflowInvocation(workflowInvocations.get(), record.receipt.run_id, ctx.callId, input);
    if (prior.result) return prior.result;
    const result = await executeLearnedWorkflow(extension.config, record, input,
      { sessionId: ctx.session.id, turnId: ctx.session.turn.id, callId: ctx.callId, signal: ctx.abortSignal });
    workflowInvocations.update(rows => rows.map(row => row.runId === record.receipt.run_id ? { ...row, result } : row));
    return result;
  },
  toModelOutput(result) { return { type: result.isError ? 'error-text' : 'text', value: result.text }; },
});

export default defineDynamic(async ctx => {
  if (!extension.config.workflows) return null;
  await instructionsFor(ctx);
  const record = learningState.get().turns.find(row => row.source.turnId === ctx.turn?.id && row.source.sessionId === ctx.session.id);
  return record?.receipt.learning.enabled && record.receipt.learning.workflows?.length ? tool : null;
});
