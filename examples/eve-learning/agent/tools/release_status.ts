import { randomUUID } from 'node:crypto';
import { defineTool } from 'eve/tools';
import { z } from 'zod';

// An existing native eve tool. Adding AgentRun never replaces or calls this callback itself.
const releases = {
  'demo-api': { version: '2.4.0', tests: 'passed', ready: true },
  'demo-worker': { version: '3.1.2', tests: 'passed', ready: true },
} as const;
export default defineTool({
  description: 'Read current fictional release status for a service. Read-only; no deployments or external calls.',
  inputSchema: z.object({ service: z.enum(['demo-api', 'demo-worker']) }),
  execute({ service }) {
    return { service, ...releases[service], observation: randomUUID() };
  },
});
