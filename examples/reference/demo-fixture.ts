// A demo's `run.ts` as the reference entry's own test uses it: the reference job and its fakes, the spec from `DEMO_SPEC` (a JSON file), the standard flags.
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeEyes, fakeTranscriptionFetch } from '@parcha/pi-vision/testing';
import { openAiTranscriber } from '@parcha/pi-vision/transcribers';
import { demo } from '@parcha/agentrun-reference';
import type { ToolContext } from '@parcha/agentrun-reference';
import type { BoxProvider } from '@parcha/pi-transport';
import { fakes, job, lead } from './job.ts';

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
      const made = await (context!.boxes as BoxProvider).create({ maxLifetimeMs: 60_000, labels: { 'agentrun-demo': 'install' } }, ctx);
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
// And code mode: the reference lead does its work, and before it submits it makes one `code` call with the script in DEMO_CODE (DEMO_CODE_ON turns code mode on). The lead never sees that exchange in its own history.
const baseLead = lead();
const codeLead = (messages: readonly Message[]) => {
  const isCode = (message: Message) => (message.role === 'toolResult' && message.toolName === 'code') || (message.role === 'assistant' && message.content.some((block) => block.type === 'toolCall' && block.name === 'code'));
  const next = baseLead(messages.filter((message) => !isCode(message)));
  const submitting = next.content.some((block) => block.type === 'toolCall' && block.name === 'submit');
  return submitting && !messages.some(isCode) ? fauxAssistantMessage([fauxToolCall('code', { code: process.env.DEMO_CODE! })], { stopReason: 'toolUse' }) : next;
};
const withSites = process.env.DEMO_SITES ? { ...job, workflow: { ...job.workflow, root: { ...job.workflow.root, steps: [...(job.workflow.root as { steps: unknown[] }).steps.slice(0, 1), { ...((job.workflow.root as { steps: unknown[] }).steps[1] as object), instructions: 'Hand the registry check to the registry site with use_website, then cite its receipt.' }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(2)] } } } as unknown as typeof job : undefined;
// And scripted eyes for the lead's images: with them the lead takes text only, so the read of the filing scan goes to the eyes (a paid look).
const eyes = process.env.DEMO_EYES ? fakeEyes({ model: 'scripted-eyes', price: { input: 1, output: 4 }, ...(process.env.DIR ? { ledgerPath: join(process.env.DIR, 'eyes.jsonl') } : {}), answers: [process.env.DEMO_EYES_FAIL ? { fail: 'the eyes are unavailable' } : 'A scanned certificate of incorporation. Incorporated on 2019-03-04.'] }) : undefined;
// And tools whose results carry secret values, in the order DEMO_LEAK_STEPS names (default `leak`): `leak` returns DEMO_LEAK (a JSON list of made-up strings), `homeToken` returns the access token the CHILD reads from the
// sign-in file under its own AGENTRUN_HOME, and `rotate` rewrites that file with DEMO_ROTATE_TOKEN as the access token (what a refresh does). Each is what a recording must not hold if a tool ever hands one back.
const authFile = () => join(process.env.AGENTRUN_HOME!, 'auth.json');
const leaking = process.env.DEMO_LEAK || process.env.DEMO_LEAK_STEPS ? {
  leak: async () => ({ text: (JSON.parse(process.env.DEMO_LEAK ?? '[]') as string[]).join(' ') }),
  // What the child and a command it starts see of KILL_NONCE (the supervisor's per-attempt nonce, which the child reads once and removes).
  envProbe: async () => { const { spawnSync } = await import('node:child_process'); const seen = { inProcess: 'KILL_NONCE' in process.env, inCommand: /^KILL_NONCE=/m.test(spawnSync('env', { encoding: 'utf8' }).stdout) }; writeFileSync(join(process.env.DIR!, 'nonce-seen.json'), JSON.stringify(seen)); return { text: 'probed' }; },
  homeToken: async () => ({ text: (JSON.parse(readFileSync(authFile(), 'utf8')) as { credentials: { openai: { access: string } } }).credentials.openai.access }),
  rotate: async () => { await new Promise((resolve) => setTimeout(resolve, Number(process.env.DEMO_ROTATE_DELAY_MS ?? 0))); const file = JSON.parse(readFileSync(authFile(), 'utf8')) as { credentials: { openai: { access: string } } }; file.credentials.openai.access = process.env.DEMO_ROTATE_TOKEN!; writeFileSync(authFile(), JSON.stringify(file)); return { text: 'rotated' }; },
  rotate2: async () => { const file = JSON.parse(readFileSync(authFile(), 'utf8')) as { credentials: { openai: { access: string } } }; file.credentials.openai.access = process.env.DEMO_ROTATE_TOKEN_2!; writeFileSync(authFile(), JSON.stringify(file)); return { text: 'rotated again' }; },
} : undefined;
const leakSteps = (process.env.DEMO_LEAK_STEPS ?? 'leak').split(',').map((name) => ({ node: 'call', label: name, via: 'tool', tool: name, args: {}, out: 'Leaked', as: `${name}Out`, deadline_s: 30 }));
const withLeak = leaking ? { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Leaked: { type: 'object' } }, root: { ...job.workflow.root, steps: [(job.workflow.root as { steps: unknown[] }).steps[0], ...leakSteps, ...(job.workflow.root as { steps: unknown[] }).steps.slice(1)] } } } as unknown as typeof job : undefined;
// And a fan-out (DEMO_FANOUT): six branches, four at a time, each a slow tool call. Crossings at the nodes' starts are often taken while another branch's call is in flight, so they are often not eligible kill points.
const fanning = process.env.DEMO_FANOUT ? { slow: async () => { await new Promise((resolve) => setTimeout(resolve, 120)); return {}; } } : undefined;
const withFan = fanning ? { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Slow: { type: 'object' } }, root: { ...job.workflow.root, steps: [(job.workflow.root as { steps: unknown[] }).steps[0], { node: 'code', label: 'items', as: 'items', code: '(s) => [1, 2, 3, 4, 5, 6]' }, { node: 'map', label: 'fan', itemsPath: 'items', as: 'fanned', resultPath: 'row', maxConcurrency: 4, body: { node: 'call', label: 'slow', via: 'tool', tool: 'slow', args: {}, out: 'Slow', as: 'row', deadline_s: 30 } }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(1)] } } } as unknown as typeof job : undefined;
const scripted = { ...fakes, ...(fanning ? { tools: { ...fakes.tools, ...fanning } } : {}), ...(leaking ? { tools: { ...fakes.tools, ...leaking } } : {}), ...(process.env.DEMO_SITES ? { model: sitesLead as typeof fakes.model } : {}), ...(process.env.DEMO_CODE ? { model: codeLead as typeof fakes.model } : {}), ...(lingering ? { tools: { ...fakes.tools, ...lingering.tools } } : {}), ...(boxTool ? { tools: { ...fakes.tools, ...(lingering?.tools ?? {}), ...boxTool } } : {}), ...(judgeCost ? { judge: async (request: Parameters<typeof fakes.judge>[0]) => ({ ...(await fakes.judge(request)), cost_usd: judgeCost }) } : {}) };
// A test knob: DEMO_OPERATOR_HOLD names the operator's control file. The first process holds the lead's first model call (blocking, in the child) until the control file has appeared and been consumed, then waits for the supervisor's kill: the run cannot
// finish before the operator's kill lands. A marker beside it lets the process that resumes after the kill go on.
const holdFile = process.env.DEMO_OPERATOR_HOLD;
let held = false;
const holdForOperator = (model: typeof fakes.model): typeof fakes.model => (messages) => {
  if (holdFile && !held) {
    held = true;
    const marker = `${holdFile}.held`;
    if (!existsSync(marker)) {
      writeFileSync(marker, '');
      const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      while (!existsSync(holdFile)) pause(5);
      while (existsSync(holdFile)) pause(5);
      pause(60_000);
    }
  }
  return model(messages);
};
const scriptedHeld = holdFile ? { ...scripted, model: holdForOperator(scripted.model) } : scripted;
// And `sourcesFor`: the items an input needs, from a JSON list whose ids start `a-` for the default company and `o-` for another.
const sourcesFor = process.env.DEMO_SOURCES_ITEMS ? (input: Record<string, unknown>) => (JSON.parse(readFileSync(process.env.DEMO_SOURCES_ITEMS!, 'utf8')) as Array<{ id: string; url: string; bytes: number; sha256: string }>).filter((item) => item.id.startsWith(input.company === 'Beta Ltd' ? 'o-' : 'a-')) : undefined;
// And a vision lane the entry must honor (`fakes.vision`) and a result hook (`result`): tests read the probe file and the recording's result.
const probe = process.env.DEMO_VISION_PROBE ? (host: { deliver?: unknown }, running: { harness: unknown }, context: { input: unknown; place: { root: string; work: string } }) => { writeFileSync(join(process.env.DIR!, 'vision-called.json'), JSON.stringify({ hasHost: typeof host.deliver === 'function', harnessUndefinedAtBuild: running.harness === undefined, input: context.input, place: context.place })); return {}; } : undefined;
const result = process.env.DEMO_RESULT ? (record: unknown, context: { keep(bytes: string, extension: string): string }) => ({ json: { format: 'agentrun.cited/1', title: 'The company', rows: [{ label: 'company', value: String((record as { company: string }).company) + (process.env.DEMO_RESULT_LEAK ? ` ${process.env.DEMO_RESULT_LEAK}` : '') + (process.env.DEMO_RESULT_PAD ? ` ${process.env.DEMO_RESULT_PAD}` : ''), cites: [{ blob: context.keep(`a cited file${process.env.DEMO_LEAK ? ` ${process.env.DEMO_LEAK}` : ''}`, 'txt') }] }] }, title: 'A cited result' }) : undefined;
// And live parts that write what the child saw: its environment's names and what its live vision was called with.
const live = process.env.DEMO_LIVE_PROBE ? (context: { env: NodeJS.ProcessEnv; models: unknown }) => {
  writeFileSync(join(process.env.DIR!, 'models-seen.json'), JSON.stringify(context.models));
  writeFileSync(join(process.env.DIR!, 'env-seen.json'), JSON.stringify(Object.keys(context.env).sort()));
  // DEMO_LIVE_TOOLS: `search` supplies a live `search` (the fakes' answer, marked `from: 'live'`); `other` supplies a tool the job does not use, so `search` is missing from the live tools.
  const liveTools: Record<string, (args: Record<string, unknown>) => unknown> | undefined = process.env.DEMO_LIVE_TOOLS === 'search' ? { search: async (args: Record<string, unknown>) => ({ ...(await fakes.tools.search!(args) as object), from: 'live' }) } : process.env.DEMO_LIVE_TOOLS === 'other' ? { other: async () => ({}) } : undefined;
  return { ...(liveTools ? { tools: liveTools } : {}), models: { lead: 'chosen-lead', eyes: 'chosen-eyes' }, vision: (host: { deliver?: unknown }, running: { harness: unknown }, context: { input: unknown; place: { root: string; work: string } }) => { writeFileSync(join(process.env.DIR!, 'live-vision.json'), JSON.stringify({ hasHost: typeof host.deliver === 'function', harnessUndefinedAtBuild: running.harness === undefined, input: context.input, place: context.place })); return {}; } };
} : undefined;
// And a manifest hook: extras, or a name the entry owns when DEMO_MANIFEST is `reserved`.
const manifest = process.env.DEMO_MANIFEST ? (context: { models?: unknown }) => (process.env.DEMO_MANIFEST === 'reserved' ? { source: 'mine' } : process.env.DEMO_MANIFEST === 'models' ? { chosen: context.models ?? null } : { sources: [{ file: 'a.pdf', sha256: 'ab' }], models: { lead: 'x' } }) : undefined;
// The demo's own vision lane: its eyes, and (DEMO_OWN_HOOKS) an `onLook` and an `onMiss` of its own, which the entry's must call and never replace.
const ownLane = () => ({
  eyes: eyes!,
  ...(process.env.DEMO_OWN_HOOKS ? {
    onLook: async () => { appendFileSync(join(process.env.DIR!, 'own-hooks.txt'), 'look\n'); },
    onMiss: async () => { appendFileSync(join(process.env.DIR!, 'own-hooks.txt'), 'miss\n'); },
  } : {}),
});
// And a scripted speech-to-text model for `vision.transcribe` (DEMO_TRANSCRIBE): OpenAI's transcriptions answered by a fake `fetch` that states the file's duration (so the price needs no ffmpeg), priced per minute, with a made-up key that only this adapter holds.
const transcribing = process.env.DEMO_TRANSCRIBE ? (() => {
  const answer = fakeTranscriptionFetch('openai', { words: [{ text: 'hello', start: 0.1, end: 0.5 }, { text: 'world', start: 0.6, end: 1 }], durationS: 2 });
  return () => ({ transcriber: openAiTranscriber({ apiKey: () => `made-up-stt-key-${'k'.repeat(24)}`, fetch: answer.fetch, usdPerMinute: 0.6 }) });
})() : undefined;
// A test knob: DEMO_REPORT is a directory the run finds as `report/` in its work directory (the agent's report folder, draft 41), however the run goes: the files are the job's, written before it starts.
const reportFiles = (dir: string, base = '', out: Record<string, Uint8Array> = {}): Record<string, Uint8Array> => {
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (entry.isDirectory()) reportFiles(dir, `${base}${entry.name}/`, out);
    else out[`report/${base}${entry.name}`] = readFileSync(join(dir, base, entry.name));
  }
  return out;
};
const withReport = (chosen: typeof job): typeof job => (process.env.DEMO_REPORT ? { ...chosen, files: { ...chosen.files, ...reportFiles(process.env.DEMO_REPORT) } } : chosen);
export const options = { ...(process.env.DEMO_FOLLOW_HOLD_MS ? { followHoldMs: Number(process.env.DEMO_FOLLOW_HOLD_MS) } : {}), ...(process.env.DEMO_CODE_ON ? { codeMode: true } : {}), ...(process.env.DEMO_ITEM ? { itemOf: (path: string) => `scan ${path}` } : {}), self: import.meta.url, spec, job: withReport(withBox ?? withFan ?? withLeak ?? withSites ?? lingering?.job ?? job), fakes: { ...scriptedHeld, ...(process.env.DEMO_FAKES_INPUT ? { input: { company: 'Beta Ltd' } } : {}), ...(probe ? { vision: probe } : eyes ? { vision: ownLane } : transcribing ? { vision: transcribing } : {}), ...(eyes ? { lead: { input: ['text' as const] } } : {}) }, ...(result ? { result } : {}), ...(live ? { live } : {}), ...(manifest ? { manifest } : {}), ...(sourcesFor ? { sourcesFor } : {}) };
if (process.argv.includes('--child')) await demo(options);
