import agentrun from '@parcha/agentrun-eve';
import { POLICY } from '../lib/policy.js';

export default agentrun({
  baseUrl: process.env.AGENTRUN_BASE_URL!,
  apiKey: process.env.AGENTRUN_API_KEY!,
  agentId: process.env.AGENTRUN_AGENT_ID!,
  name: 'Existing eve release reporter',
  instructions: POLICY,
  learning: false,
});
