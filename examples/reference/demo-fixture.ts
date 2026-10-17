// A demo's `run.ts` as the reference entry's own test uses it: the reference job and its fakes, the spec from `DEMO_SPEC` (a JSON file), the standard flags.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demo } from './demo.ts';
import type { ToolContext } from './host.ts';
import { fakes, job } from './job.ts';

const spec = JSON.parse(readFileSync(process.env.DEMO_SPEC!, 'utf8'));
// A test knob: what the judge costs, so a run can pass a spend cap.
const judgeCost = Number(process.env.DEMO_JUDGE_COST ?? 0);
// Another: a slow step after the judge, so a cap can stop a run that is still going.
const linger = Number(process.env.DEMO_LINGER_MS ?? 0);
const lingering = linger ? {
  job: { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Waited: { type: 'object' } }, root: { ...job.workflow.root, steps: [...(job.workflow.root as { steps: unknown[] }).steps.slice(0, 3), { node: 'call', label: 'linger', via: 'tool', tool: 'linger', args: {}, out: 'Waited', as: 'waited', deadline_s: 60 }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(3)] } } } as unknown as typeof job,
  tools: { linger: async () => { await new Promise((resolve) => setTimeout(resolve, linger)); return {}; } },
} : undefined;
// And a tool that installs in a box of its own, as the audit's install does: it makes a box, runs a command in it, and when the box is lost makes another and runs it again.
const boxTool = process.env.DEMO_BOX_TOOL ? {
  install: async (_args: Record<string, unknown>, context?: ToolContext) => {
    const { finish } = await import('@parcha/pi-transport');
    const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const made = await context!.boxes!.create({ maxLifetimeMs: 60_000, labels: { 'agentrun-demo': 'install' } }, ctx);
      if (!made.ok) throw made.error;
      // When the demo plans to lose the install box, its first command WAITS UNTIL IT IS KILLED (no timer at all): the loss always lands mid-command, however slow the machine, and the second attempt's short command completes. Without a planned loss the command completes normally.
      const losing = attempt === 1 && (spec.kills ?? []).some((kill: { target?: string }) => kill.target === 'tool');
      const ran = await made.value.exec([process.execPath, '-e', losing ? 'setInterval(() => {}, 1000)' : `setTimeout(() => console.log("installed"), ${attempt === 1 ? 400 : 50})`], undefined, ctx);
      const done = ran.ok ? await finish(ran.value, undefined) : undefined;
      await made.value.destroy(ctx);
      if (done?.ok && done.value.exitCode === 0) return { attempts: attempt };
    }
    throw new Error('the install failed twice');
  },
} : undefined;
const withBox = boxTool ? { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Installed: { type: 'object' } }, root: { ...job.workflow.root, steps: [(job.workflow.root as { steps: unknown[] }).steps[0], { node: 'call', label: 'install', via: 'tool', tool: 'install', args: {}, out: 'Installed', as: 'installed', deadline_s: 60 }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(1)] } } } as unknown as typeof job : undefined;
const scripted = { ...fakes, ...(lingering ? { tools: { ...fakes.tools, ...lingering.tools } } : {}), ...(boxTool ? { tools: { ...fakes.tools, ...(lingering?.tools ?? {}), ...boxTool } } : {}), ...(judgeCost ? { judge: async (request: Parameters<typeof fakes.judge>[0]) => ({ ...(await fakes.judge(request)), cost_usd: judgeCost }) } : {}) };
// And a vision lane the entry must honor (`fakes.vision`) and a result hook (`result`): tests read the probe file and the recording's result.
const probe = process.env.DEMO_VISION_PROBE ? (host: { deliver?: unknown }, running: { harness: unknown }) => { writeFileSync(join(process.env.DIR!, 'vision-called.json'), JSON.stringify({ hasHost: typeof host.deliver === 'function', harnessUndefinedAtBuild: running.harness === undefined })); return {}; } : undefined;
const result = process.env.DEMO_RESULT ? (record: unknown, context: { keep(bytes: string, extension: string): string }) => ({ json: { format: 'agentrun.cited/1', title: 'The company', rows: [{ label: 'company', value: String((record as { company: string }).company), cites: [{ blob: context.keep('a cited file', 'txt') }] }] }, title: 'A cited result' }) : undefined;
// And live parts that write what the child saw: its environment's names and what its live vision was called with.
const live = process.env.DEMO_LIVE_PROBE ? (context: { env: NodeJS.ProcessEnv; models: unknown }) => {
  writeFileSync(join(process.env.DIR!, 'models-seen.json'), JSON.stringify(context.models));
  writeFileSync(join(process.env.DIR!, 'env-seen.json'), JSON.stringify(Object.keys(context.env).sort()));
  return { vision: (host: { deliver?: unknown }, running: { harness: unknown }) => { writeFileSync(join(process.env.DIR!, 'live-vision.json'), JSON.stringify({ hasHost: typeof host.deliver === 'function', harnessUndefinedAtBuild: running.harness === undefined })); return {}; } };
} : undefined;
// And a manifest hook: extras, or a name the entry owns when DEMO_MANIFEST is `reserved`.
const manifest = process.env.DEMO_MANIFEST ? () => (process.env.DEMO_MANIFEST === 'reserved' ? { source: 'mine' } : { sources: [{ file: 'a.pdf', sha256: 'ab' }], models: { lead: 'x' } }) : undefined;
export const options = { self: import.meta.url, spec, job: withBox ?? lingering?.job ?? job, fakes: { ...scripted, ...(probe ? { vision: probe } : {}) }, ...(result ? { result } : {}), ...(live ? { live } : {}), ...(manifest ? { manifest } : {}) };
if (process.argv.includes('--child')) await demo(options);
