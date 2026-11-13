import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCodexAgentLearning } from '@parcha/agentrun-client/codex';
import { demonstrate, INSTRUCTIONS, STATUS, requireLive } from './demo.mjs';

/** Existing backend: retain its Codex instance/configuration and create one fresh native thread per request. */
export function createCodexReleaseBackend(existingCodex, learning, existingThreadOptions) {
  const codex = withCodexAgentLearning(existingCodex, learning);
  return {
    async report(prompt) {
      const result = await codex.startThread(existingThreadOptions).run(prompt);
      return { answer: result.finalResponse, toolCalls: result.items.filter(item => item.type === 'command_execution' && item.status === 'completed').length };
    },
    flushLearning: () => codex.flushLearning(),
  };
}

/** Fictional read-only project, shared by all three independent threads. */
export async function releaseWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-sdk-release-'));
  await writeFile(join(directory, 'release-status.json'), JSON.stringify(STATUS));
  await writeFile(join(directory, 'AGENTS.md'), INSTRUCTIONS + '\nThe read-only release status is in release-status.json. Read it with your normal shell tool.\n');
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

if (import.meta.main) {
  requireLive();
  const { Codex } = await import('@openai/codex-sdk');
  const existingCodex = new Codex(); // Uses your existing Codex configuration and credentials.
  const workspace = await releaseWorkspace();
  try {
    const options = { workingDirectory: workspace.directory, sandboxMode: 'read-only',
      skipGitRepoCheck: true, approvalPolicy: 'never', ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}) };
    const evidence = await demonstrate({ runtime: 'codex', createBackend: learning => createCodexReleaseBackend(existingCodex, learning, options) });
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await workspace.cleanup(); }
}
