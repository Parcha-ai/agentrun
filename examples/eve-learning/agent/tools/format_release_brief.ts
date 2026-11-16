import { defineDynamic, defineTool } from 'eve/tools';
import { z } from 'zod';
import { formatReleaseBrief } from '../lib/release-tools.js';

const tool = defineTool({
  description: 'Format a release brief from the complete unchanged status returned by release_status in this task. Returns a brief string; no model call or deployment.',
  inputSchema: z.object({ status: z.object({ service: z.enum(['demo-api', 'demo-worker']),
    version: z.string(), tests: z.string(), ready: z.boolean(), observation: z.string() }).strict() }).strict(),
  execute(input, ctx) { return formatReleaseBrief(input, { sessionId: ctx.session.id }); },
});

// The original notes demo keeps its original tool surface unless workflow proof is explicitly enabled.
export default defineDynamic(() => process.env.EVE_WORKFLOW_AUDIT_PATH ? tool : null);
