import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { readReleaseStatus } from '../lib/release-tools.js';

// An existing native eve tool. Adding AgentRun never replaces or calls this callback itself.
export default defineTool({
  description: 'Read current fictional release status for a service. Read-only; no deployments or external calls.',
  inputSchema: z.object({ service: z.enum(['demo-api', 'demo-worker']) }),
  execute({ service }, ctx) {
    return readReleaseStatus({ service }, { sessionId: ctx.session.id });
  },
});
