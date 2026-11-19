import agentrun from '@parcha/agentrun-eve';
import * as workflowEngine from '@parcha/agentrun-dsl';
import { POLICY } from '../lib/policy.js';
import { releaseWorkflowTools } from '../lib/release-tools.js';

if (!process.env.EVE_WORKFLOW_AUDIT_PATH) throw new Error('Set a private EVE_WORKFLOW_AUDIT_PATH for the workflow proof.');
export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!, apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: process.env.AGENTRUN_AGENT_ID!, name: 'Existing eve workflow release reporter',
  instructions: POLICY, learning: false,
  workflows: { engine: workflowEngine, tools: releaseWorkflowTools,
    policy: () => 'allow', maxToolCalls: 8, maxDurationMs: 30_000 },
});
