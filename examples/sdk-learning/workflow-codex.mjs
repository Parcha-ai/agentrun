import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCodexAgentLearning } from '@parcha/agentrun-client/codex';
import { createWorkflowMcpBridge } from '@parcha/agentrun-client/workflows';
import * as workflowEngine from '@parcha/agentrun-dsl';
import { createReleaseWorkflowTools, WORKFLOW_INSTRUCTIONS } from './workflow-tools.mjs';
import { serveReleaseTools } from './workflow-native-mcp.mjs';
import { demonstrateWorkflows } from './workflow-demo.mjs';
import { requireLive } from './demo.mjs';

/** Native MCP setup belongs to the backend: use this config alongside its existing Codex constructor options. */
export async function createCodexWorkflowReleaseBackend(createExistingCodex, learning, existingThreadOptions = {}) {
  const backend = createReleaseWorkflowTools(), workflowEvents = [];
  const nativeTools = await serveReleaseTools(backend.tools);
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-workflow-release-'));
  let bridge;
  try {
    await writeFile(join(directory, 'AGENTS.md'), WORKFLOW_INSTRUCTIONS + '\n');
    bridge = await createWorkflowMcpBridge({ engine: workflowEngine, tools: backend.tools, policy: async () => 'allow',
      onEvent: event => workflowEvents.push(event) });
    // Codex config is constructor-owned. The wrapper receives this exact instance and does not replace its auth/config.
    const existingCodex = createExistingCodex({ mcp_servers: {
      release: { url: nativeTools.url, http_headers: nativeTools.headers },
      agentrun_workflows: { url: bridge.url, http_headers: bridge.headers },
    } });
    const codex = withCodexAgentLearning(existingCodex, { ...learning, workflows: bridge });
    const options = { workingDirectory: directory, sandboxMode: 'read-only', skipGitRepoCheck: true,
      approvalPolicy: 'never', ...existingThreadOptions };
    return {
      async report(prompt) {
        const fromCalls = backend.calls.length, fromEvents = workflowEvents.length;
        const result = await codex.startThread(options).run(prompt);
        return { answer: result.finalResponse, calls: backend.calls.slice(fromCalls), workflowEvents: workflowEvents.slice(fromEvents) };
      },
      flushLearning: () => codex.flushLearning(),
      async close() { await bridge.close(); await nativeTools.close(); await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { await bridge?.close(); await nativeTools.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  requireLive();
  const { Codex } = await import('@openai/codex-sdk');
  const evidence = await demonstrateWorkflows({ runtime: 'codex',
    createBackend: learning => createCodexWorkflowReleaseBackend(config => new Codex({ config }), learning,
      process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
    onProgress: progress => console.error(JSON.stringify(progress)),
  });
  console.log(JSON.stringify(evidence, null, 2));
}
