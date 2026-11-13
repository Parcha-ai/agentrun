import { withClaudeAgentLearning } from '@parcha/agentrun-client/claude';
import { createWorkflowMcpBridge } from '@parcha/agentrun-client/workflows';
import { createReleaseWorkflowTools, WORKFLOW_INSTRUCTIONS } from './workflow-tools.mjs';
import { serveReleaseTools } from './workflow-native-mcp.mjs';
import { demonstrateWorkflows } from './workflow-demo.mjs';
import { requireLive } from './demo.mjs';

export async function createClaudeWorkflowReleaseBackend(sdk, learning, existingOptions = {}) {
  const backend = createReleaseWorkflowTools(), workflowEvents = [];
  const nativeTools = await serveReleaseTools(backend.tools);
  let bridge;
  try {
    bridge = await createWorkflowMcpBridge({ tools: backend.tools, policy: async () => 'allow',
      onEvent: event => workflowEvents.push(event) });
    if (existingOptions.mcpServers?.release || existingOptions.mcpServers?.agentrun_workflows)
      throw new Error('The demo MCP names are already configured. Choose distinct names explicitly.');
    const query = withClaudeAgentLearning(sdk.query, { ...learning, workflows: bridge });
    const options = { ...existingOptions, systemPrompt: existingOptions.systemPrompt ?? WORKFLOW_INSTRUCTIONS,
      maxTurns: existingOptions.maxTurns ?? 8,
      mcpServers: { ...existingOptions.mcpServers,
        release: { type: 'http', url: nativeTools.url, headers: nativeTools.headers, alwaysLoad: true },
        agentrun_workflows: { type: 'http', url: bridge.url, headers: bridge.headers, alwaysLoad: true },
      },
      allowedTools: [...(existingOptions.allowedTools ?? []), 'mcp__release__release_status',
        'mcp__release__format_release_brief', 'mcp__agentrun_workflows__learned_workflow'],
    };
    return {
      async report(prompt) {
        const fromCalls = backend.calls.length, fromEvents = workflowEvents.length;
        let answer;
        for await (const event of query({ prompt, options })) {
          if (event.type === 'result') {
            if (event.is_error || event.subtype !== 'success') throw new Error('The original Claude Agent SDK task did not succeed.');
            answer = event.result;
          }
        }
        if (typeof answer !== 'string') throw new Error('The original Claude Agent SDK did not return a final result.');
        return { answer, calls: backend.calls.slice(fromCalls), workflowEvents: workflowEvents.slice(fromEvents) };
      },
      flushLearning: () => query.flushLearning(),
      async close() { await bridge.close(); await nativeTools.close(); },
    };
  } catch (error) { await bridge?.close(); await nativeTools.close(); throw error; }
}

if (import.meta.main) {
  requireLive();
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const evidence = await demonstrateWorkflows({ runtime: 'claude',
    createBackend: learning => createClaudeWorkflowReleaseBackend(sdk, learning, process.env.CLAUDE_MODEL ? { model: process.env.CLAUDE_MODEL } : {}),
    onProgress: progress => console.error(JSON.stringify(progress)),
  });
  console.log(JSON.stringify(evidence, null, 2));
}
