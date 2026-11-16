import { randomUUID } from 'node:crypto';
import { appendFile, readFile, stat } from 'node:fs/promises';

// Fictional fixtures only. The optional journal proves callback execution across Eve workers;
// it never records native prompts, credentials, capabilities, or arbitrary tool payloads.
export const RELEASES = {
  'demo-api': { version: '2.4.0', tests: 'passed', ready: true },
  'demo-worker': { version: '3.1.2', tests: 'passed', ready: true },
} as const;
type Service = keyof typeof RELEASES;
type Status = { service: Service; version: string; tests: string; ready: boolean; observation: string };
type Context = { sessionId?: string; runId?: string; workflow?: string; signal?: AbortSignal; auditPath?: string };
type Audit = { tool: string; source: 'native' | 'workflow'; sessionId?: string; runId?: string; workflow?: string;
  input: unknown; result: unknown };
const MAX_AUDIT_BYTES = 4_000_000;
const pathOf = (ctx: Context) => ctx.auditPath ?? process.env.EVE_WORKFLOW_AUDIT_PATH;
const identity = (ctx: Context) => ctx.workflow ? { source: 'workflow' as const, runId: ctx.runId, workflow: ctx.workflow }
  : { source: 'native' as const, sessionId: ctx.sessionId };

export async function readWorkflowAudit(path: string): Promise<Audit[]> {
  const size = (await stat(path)).size;
  if (size > MAX_AUDIT_BYTES) throw new Error('The fictional workflow audit exceeds its bounded proof size.');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_AUDIT_BYTES) throw new Error('The fictional workflow audit exceeds its bounded proof size.');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Audit);
}

async function record(tool: string, input: unknown, result: unknown, ctx: Context) {
  ctx.signal?.throwIfAborted();
  const path = pathOf(ctx);
  if (path) {
    if (ctx.workflow ? !ctx.runId : !ctx.sessionId) throw new Error('The workflow proof needs its original execution identity.');
    const existing = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const line = JSON.stringify({ tool, ...identity(ctx), input, result }) + '\n';
    if ((existing?.size ?? 0) + Buffer.byteLength(line) > MAX_AUDIT_BYTES) throw new Error('The fictional workflow audit is full.');
    await appendFile(path, line, { mode: 0o600 });
  }
  return result;
}

export async function readReleaseStatus(input: Record<string, unknown>, ctx: Context = {}): Promise<Status> {
  const service = input.service;
  if (typeof service !== 'string' || !Object.hasOwn(RELEASES, service)) throw new Error('Unknown fictional service.');
  const result = { service: service as Service, ...RELEASES[service as Service], observation: randomUUID() };
  await record('release_status', { service }, result, ctx);
  return result;
}

export async function formatReleaseBrief(input: Record<string, unknown>, ctx: Context = {}): Promise<{ brief: string }> {
  const path = pathOf(ctx);
  if (!path) throw new Error('Set a private EVE_WORKFLOW_AUDIT_PATH for the optional workflow example.');
  const status = input.status as Status | undefined;
  const same = identity(ctx);
  const audit = await readWorkflowAudit(path);
  const seen = audit.findLast(row => row.tool === 'release_status' && row.source === same.source
    && row.sessionId === same.sessionId && row.runId === same.runId && row.workflow === same.workflow
    && (row.result as Status)?.observation === status?.observation)?.result as Status | undefined;
  if (!status || !seen || Object.keys(status).length !== Object.keys(seen).length
    || Object.entries(seen).some(([key, value]) => status[key as keyof Status] !== value)) {
    throw new Error('The formatter requires the complete unchanged status from this task’s original release_status callback.');
  }
  const result = { brief: `Release brief: ${seen.service} ${seen.version}; tests ${seen.tests}; ${seen.ready ? 'ready' : 'not ready'}.` };
  await record('format_release_brief', { status }, result, ctx);
  return result;
}

const string = { type: 'string' };
// Fixture records are runtime data, not a reusable workflow's closed list of service names.
// The original callback still rejects unknown services instead of inventing release status.
export const statusSchema = { type: 'object', additionalProperties: false,
  required: ['service', 'version', 'tests', 'ready', 'observation'], properties: {
    service: string, version: string, tests: string,
    ready: { type: 'boolean' }, observation: string,
  } };

// These execute references are the functions the authored Eve tools call. There is no second
// implementation and no implicit grant of other tools, shell, model, or judgment adapters.
export const releaseWorkflowTools = [{
  name: 'mcp:release/release_status', nativeName: 'release_status',
  description: 'Read fresh fictional release data. Pass the whole result unchanged to format_release_brief.',
  input_schema: { type: 'object', additionalProperties: false, required: ['service'],
    properties: { service: string } },
  output_schema: statusSchema, permission: 'allow' as const, price_usd: 0, readOnly: true as const,
  execute: readReleaseStatus,
}, {
  name: 'mcp:release/format_release_brief', nativeName: 'format_release_brief',
  description: 'Format the complete unchanged fresh status object from release_status. Returns a brief string without another model call.',
  input_schema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: statusSchema } },
  output_schema: { type: 'object', additionalProperties: false, required: ['brief'], properties: { brief: string } },
  permission: 'allow' as const, price_usd: 0, readOnly: true as const, execute: formatReleaseBrief,
}];
