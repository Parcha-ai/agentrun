import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withCodexAgentLearning } from '@parcha/agentrun-client/codex';
import { demonstrate, INSTRUCTIONS, STATUS, requireLive } from './demo.mjs';

export const MCP_INSTRUCTIONS = INSTRUCTIONS + '\nRead the status with the release_status tool from the release MCP server. Do not use shell commands to obtain it.';

/** This is the existing backend's native Codex MCP configuration, not an AgentRun-added tool. */
export function releaseMcpConfig() {
  return { mcp_servers: { release: { command: process.execPath,
    args: [fileURLToPath(new URL('./release-mcp.mjs', import.meta.url))] } } };
}

/** Existing backend: retain its Codex instance/configuration and create one fresh native thread per request. */
export function createCodexReleaseBackend(existingCodex, learning, existingThreadOptions) {
  const codex = withCodexAgentLearning(existingCodex, learning);
  return {
    async report(prompt) {
      const result = await codex.startThread(existingThreadOptions).run(prompt);
      return { answer: result.finalResponse, toolCalls: result.items.filter(item =>
        (item.type === 'command_execution' || item.type === 'mcp_tool_call') && item.status === 'completed').length };
    },
    flushLearning: () => codex.flushLearning(),
  };
}

/** Fictional read-only project, shared by all three independent threads. */
export async function releaseWorkspace({ mcp = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-sdk-release-'));
  await writeFile(join(directory, 'release-status.json'), JSON.stringify(STATUS));
  await writeFile(join(directory, 'AGENTS.md'), mcp ? MCP_INSTRUCTIONS + '\n'
    : INSTRUCTIONS + '\nThe read-only release status is in release-status.json. Read it with your normal shell tool.\n');
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

if (import.meta.main) {
  requireLive();
  const { Codex } = await import('@openai/codex-sdk');
  const mcp = process.argv.includes('--mcp');
  const existingCodex = new Codex(mcp ? { config: releaseMcpConfig() } : undefined); // Existing backend setup and credentials.
  const workspace = await releaseWorkspace({ mcp });
  try {
    const options = { workingDirectory: workspace.directory, sandboxMode: 'read-only',
      skipGitRepoCheck: true, approvalPolicy: 'never', ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}) };
    const evidence = await demonstrate({ runtime: 'codex', createBackend: learning => createCodexReleaseBackend(existingCodex,
      mcp ? { ...learning, instructions: MCP_INSTRUCTIONS } : learning, options) });
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await workspace.cleanup(); }
}
