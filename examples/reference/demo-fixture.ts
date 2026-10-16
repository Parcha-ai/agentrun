// A demo's `run.ts` as the reference entry's own test uses it: the reference job and its fakes, the spec from `DEMO_SPEC` (a JSON file), the standard flags.
import { readFileSync } from 'node:fs';
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
export const options = { self: import.meta.url, spec, job: withBox ?? lingering?.job ?? job, fakes: scripted };
if (process.argv.includes('--child')) await demo(options);
