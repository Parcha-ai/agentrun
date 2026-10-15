// A demo's `run.ts` as the reference entry's own test uses it: the reference job and its fakes, the spec from `DEMO_SPEC` (a JSON file), the standard flags.
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
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
      const ran = await made.value.exec([process.execPath, '-e', 'setTimeout(() => console.log("installed"), 400)'], undefined, ctx);
      const done = ran.ok ? await finish(ran.value, undefined) : undefined;
      await made.value.destroy(ctx);
      if (done?.ok && done.value.exitCode === 0) return { attempts: attempt };
    }
    throw new Error('the install failed twice');
  },
} : undefined;
const withBox = boxTool ? { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Installed: { type: 'object' } }, root: { ...job.workflow.root, steps: [(job.workflow.root as { steps: unknown[] }).steps[0], { node: 'call', label: 'install', via: 'tool', tool: 'install', args: {}, out: 'Installed', as: 'installed', deadline_s: 60 }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(1)] } } } as unknown as typeof job : undefined;
// And `use_website`: the parent hands the registry check to a site, whose child agent opens the page, reads it and reports with the receipt's path; the parent cites it.
const siteText = (message: { content: unknown }) => (typeof message.content === 'string' ? message.content : (message.content as Array<{ type: string; text?: string }>).map((block) => (block.type === 'text' ? block.text ?? '' : '')).join(''));
const sitesLead = (messages: readonly { role: string; content: unknown }[]) => {
  const first = siteText(messages.find((message) => message.role === 'user')!);
  const results = messages.filter((message) => message.role === 'toolResult');
  const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: 'toolUse' });
  const start = /Start at (https?:\/\/\S+?)\.?\s/.exec(first);
  if (start) {
    if (results.length === 0) return call('run', { code: `await page.goto(${JSON.stringify(start[1])})` });
    if (results.length === 1) return call('browser_read', { what: 'markdown' });
    const path = /evidence\/[\w./-]+\.json/.exec(siteText(results[1]!))?.[0] ?? 'no receipt';
    return fauxAssistantMessage(`Acme Ltd was incorporated on 2019-03-04. Receipt: ${path}`);
  }
  if (results.length === 0) return call('use_website', { site: 'registry', request_id: '3f2b8a1c-7d4e-4b9a-8c1d-5e6f7a8b9c0d', instructions: 'When was Acme Ltd incorporated? Quote the receipt path of the page you read.' });
  const path = /evidence\/[\w./-]+\.json/.exec(siteText(results.at(-1)!))?.[0] ?? '';
  return call('submit', { answer: 'Acme Ltd was incorporated on 2019-03-04.', citations: path ? [path] : [] });
};
const withSites = process.env.DEMO_SITES ? { ...job, workflow: { ...job.workflow, root: { ...job.workflow.root, steps: [...(job.workflow.root as { steps: unknown[] }).steps.slice(0, 1), { ...((job.workflow.root as { steps: unknown[] }).steps[1] as object), instructions: 'Hand the registry check to the registry site with use_website, then cite its receipt.' }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(2)] } } } as unknown as typeof job : undefined;
const scripted = { ...fakes, ...(process.env.DEMO_SITES ? { model: sitesLead as typeof fakes.model } : {}), ...(lingering ? { tools: { ...fakes.tools, ...lingering.tools } } : {}), ...(boxTool ? { tools: { ...fakes.tools, ...(lingering?.tools ?? {}), ...boxTool } } : {}), ...(judgeCost ? { judge: async (request: Parameters<typeof fakes.judge>[0]) => ({ ...(await fakes.judge(request)), cost_usd: judgeCost }) } : {}) };
export const options = { self: import.meta.url, spec, job: withBox ?? withSites ?? lingering?.job ?? job, fakes: scripted };
if (process.argv.includes('--child')) await demo(options);
