import { withClaudeAgentLearning } from '@parcha/agentrun-client/claude';
import { demonstrate, INSTRUCTIONS, STATUS, requireLive } from './demo.mjs';

/** Existing backend: its own query function, custom tool and execution options. Only query is decorated. */
export function createClaudeReleaseBackend(sdk, learning, existingOptions = {}) {
  let toolCalls = 0;
  const release = sdk.createSdkMcpServer({ name: 'release', version: '1.0.0', tools: [
    sdk.tool('release_status', 'Read the current fictional release status. No side effects.', {}, async () => {
      toolCalls++;
      return { content: [{ type: 'text', text: JSON.stringify(STATUS) }] };
    }),
  ] });
  const query = withClaudeAgentLearning(sdk.query, learning);
  const options = { systemPrompt: INSTRUCTIONS, maxTurns: 6,
    mcpServers: { release }, allowedTools: ['mcp__release__release_status'], ...existingOptions };
  return {
    async report(prompt) {
      const before = toolCalls;
      let answer;
      for await (const event of query({ prompt, options })) {
        if (event.type === 'result') {
          if (event.is_error || event.subtype !== 'success') throw new Error('The original Claude Agent SDK task did not succeed.');
          answer = event.result;
        }
      }
      if (typeof answer !== 'string') throw new Error('The original Claude Agent SDK did not return a final result.');
      return { answer, toolCalls: toolCalls - before };
    },
    flushLearning: () => query.flushLearning(),
  };
}

if (import.meta.main) {
  requireLive();
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const model = process.env.CLAUDE_MODEL;
  const evidence = await demonstrate({ runtime: 'claude', createBackend: learning => createClaudeReleaseBackend(sdk, learning, model ? { model } : {}) });
  console.log(JSON.stringify(evidence, null, 2));
}
