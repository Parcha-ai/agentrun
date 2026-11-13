// Fictional read-only backend tools. Their callback references are shared by native MCP and learned workflows.
import { randomUUID } from 'node:crypto';

export const RELEASES = Object.freeze({
  'demo-api': Object.freeze({ service: 'demo-api', version: '2.4.0', state: 'ready', tests: 'passed' }),
  'billing-api': Object.freeze({ service: 'billing-api', version: '3.1.2', state: 'ready', tests: 'passed' }),
});
export const WORKFLOW_INSTRUCTIONS = 'You are a backend release reporter. Report only fresh values observed through the existing release tools. Follow the user\'s requested reporting procedure. Do not modify files, deploy, or run shell commands. If an approved learned workflow handles the request, use it and return its brief without changing the values.';
export const releaseTask = service => `Prepare a release brief for ${service} from its current release data.`;
export const teachReleaseTask = service => releaseTask(service) + ' For this and future release briefs, follow this reusable two-step procedure: call release_status for the requested service, then pass its entire returned status object unchanged to format_release_brief. Return exactly the formatter\'s brief. Keep this procedure as a reusable skill so it can become a workflow after repeated use. Service names, versions and observations are per-request data, never constants to remember.';
const string = { type: 'string' };
const statusSchema = { type: 'object', additionalProperties: false, required: ['service', 'version', 'state', 'tests', 'observation'],
  properties: { service: string, version: string, state: string, tests: string, observation: string } };

export function createReleaseWorkflowTools() {
  const calls = [], observed = new Map();
  const record = (tool, args, ctx, result) => {
    calls.push({ tool, source: ctx.workflow ? 'workflow' : 'native', runId: ctx.runId,
      ...(ctx.workflow ? { workflow: ctx.workflow } : {}), args: structuredClone(args), result: structuredClone(result) });
    return result;
  };
  const tools = [{
    name: 'mcp:release/release_status', description: 'Read current release data for a service. Returns service, version, tests, state and a fresh observation identifier. Pass the whole result unchanged as status to format_release_brief.',
    input_schema: { type: 'object', additionalProperties: false, required: ['service'], properties: { service: string } },
    output_schema: statusSchema, permission: 'allow', price_usd: 0,
    async execute(args, ctx) {
      ctx.signal?.throwIfAborted();
      const known = typeof args.service === 'string' && Object.hasOwn(RELEASES, args.service) ? RELEASES[args.service] : undefined;
      if (!known) throw new Error('Unknown fictional service.');
      const status = { ...known, observation: randomUUID() };
      observed.set(status.observation, status);
      return record('mcp:release/release_status', args, ctx, status);
    },
  }, {
    name: 'mcp:release/format_release_brief', description: 'Format the complete, unchanged status object returned by release_status into a concise release brief. Returns an object with a brief string. This is a local read-only formatter with no model call.',
    input_schema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: statusSchema } },
    output_schema: { type: 'object', additionalProperties: false, required: ['brief'], properties: { brief: string } },
    permission: 'allow', price_usd: 0,
    async execute(args, ctx) {
      ctx.signal?.throwIfAborted();
      const status = args.status, known = status && observed.get(status.observation);
      if (!known || Object.keys(known).some(key => status[key] !== known[key]) || Object.keys(status).length !== Object.keys(known).length)
        throw new Error('The formatter requires the complete observed status from release_status.');
      return record('mcp:release/format_release_brief', args, ctx,
        { brief: `Release brief: ${status.service} ${status.version}; tests ${status.tests}; ${status.state}.` });
    },
  }];
  return { tools, calls };
}
