// A demo's `run.ts` as the reference entry's own test uses it: the reference job and its fakes, the spec from `DEMO_SPEC` (a JSON file), the standard flags.
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEyes, fakeTranscriptionFetch } from '@parcha/pi-vision/testing';
import { openAiTranscriber } from '@parcha/pi-vision/transcribers';
import { demo } from '@parcha/agentrun-harness';
import type { ToolContext } from '@parcha/agentrun-harness';
import type { BoxProvider } from '@parcha/pi-transport';
import { fakes, job, lead } from './job.ts';

const spec = JSON.parse(readFileSync(process.env.DEMO_SPEC!, 'utf8'));
// A test knob: what the judge costs, so a run can pass a spend cap.
const judgeCost = Number(process.env.DEMO_JUDGE_COST ?? 0);
// Another: a slow step after the judge, so a cap can stop a run that is still going.
const linger = Number(process.env.DEMO_LINGER_MS ?? 0);
// Or a step held until a file exists, so a test can keep the run going until the supervisor has done something (the test writes the file).
const lingerUntil = process.env.DEMO_LINGER_UNTIL;
const lingering = linger || lingerUntil ? {
  job: { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Waited: { type: 'object' } }, root: { ...job.workflow.root, steps: [...(job.workflow.root as { steps: unknown[] }).steps.slice(0, 3), { node: 'call', label: 'linger', via: 'tool', tool: 'linger', args: {}, out: 'Waited', as: 'waited', deadline_s: 60 }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(3)] } } } as unknown as typeof job,
  tools: { linger: async () => { if (lingerUntil) while (!existsSync(lingerUntil)) await new Promise((resolve) => setTimeout(resolve, 20)); else await new Promise((resolve) => setTimeout(resolve, linger)); return {}; } },
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
// And tool-made boxes on two providers of the demo's own (`DEMO_PROVIDERS`): the harness taps them and hands them to the tools as `context.providers`. Two fake providers, `alpha` and `beta`, are directories of this
// machine under the run's root. The tool runs two commands in an alpha box (role `worker`) and one in a beta box, ends the alpha box, and ends the beta box too unless `DEMO_PROVIDERS=leave`; it answers each box's label.
const named = (name: string, provider: BoxProvider): BoxProvider => ({ name, create: (spec, context) => provider.create(spec, context), attach: (id, context) => provider.attach(id, context), list: (labels, context) => provider.list(labels, context) });
const providers = process.env.DEMO_PROVIDERS ? async (context: { root: string }) => {
  const { localBoxes } = await import('@parcha/pi-transport/box/local');
  return { alpha: named('alpha', localBoxes({ root: join(context.root, 'alpha') })), beta: named('beta', localBoxes({ root: join(context.root, 'beta') })) };
} : undefined;
const providersTool = process.env.DEMO_PROVIDERS && process.env.DEMO_PROVIDERS !== 'ext' ? {
  boxes2: async (_args: Record<string, unknown>, context?: ToolContext) => {
    const { finish } = await import('@parcha/pi-transport');
    const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
    const given = (context as { providers?: Record<string, BoxProvider> } | undefined)?.providers;
    if (!given?.alpha || !given.beta) throw new Error('the harness handed the tool no providers');
    const make = async (provider: BoxProvider, labels: Record<string, string>) => { const made = await provider.create({ maxLifetimeMs: 60_000, labels }, ctx); if (!made.ok) throw made.error; return made.value; };
    const run = async (box: Awaited<ReturnType<typeof make>>, text: string) => { const ran = await box.exec([process.execPath, '-e', `console.log(${JSON.stringify(text)})`], undefined, ctx); if (!ran.ok) throw ran.error; const done = await finish(ran.value, undefined); if (!done.ok || done.value.exitCode !== 0) throw new Error('a command failed'); };
    const alpha = await make(given.alpha, { role: 'worker' });
    const beta = await make(given.beta, {});
    await run(alpha, 'one');
    await run(alpha, 'two');
    await run(beta, 'three');
    await alpha.destroy(ctx);
    if (process.env.DEMO_PROVIDERS !== 'leave') await beta.destroy(ctx);
    return { alpha: (alpha as { label?: string }).label ?? null, beta: (beta as { label?: string }).label ?? null };
  },
} : undefined;
// And an agent's own tool on those providers (`DEMO_PROVIDERS=ext`): `providerExtensions` gets the tapped providers, and its `make_boxes` tool (an extension tool the lead calls before it submits,
// not a call node) makes an alpha box (role `ext`), runs one command in it and ends it, answering the box's label. `DEMO_EXT_ALONE` passes the hook with no providers, which the entry refuses.
const providerExtensions = process.env.DEMO_PROVIDERS === 'ext' || process.env.DEMO_EXT_ALONE ? async (context: { providers: Readonly<Record<string, unknown>> }) => {
  const { defineExtension, defineTool } = await import('@earendil-works/pi-durable');
  const { Type } = await import('typebox');
  const alpha = context.providers.alpha as BoxProvider | undefined;
  return [defineExtension({ name: 'fixture-boxes', tools: [defineTool({
    name: 'make_boxes', description: 'Makes a box, runs one command in it and ends it.', parameters: Type.Object({}),
    execute: async () => {
      const { finish } = await import('@parcha/pi-transport');
      const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
      if (!alpha) throw new Error('the extension was handed no alpha provider');
      const made = await alpha.create({ maxLifetimeMs: 60_000, labels: { role: 'ext' } }, ctx);
      if (!made.ok) throw made.error;
      const ran = await made.value.exec([process.execPath, '-e', 'console.log("made")'], undefined, ctx);
      if (ran.ok) await finish(ran.value, undefined);
      await made.value.destroy(ctx);
      const box = (made.value as { label?: string }).label ?? null;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ box }) }], details: { box } };
    },
  })] })];
} : undefined;
const extLead = (messages: readonly Message[]) => {
  const isExt = (message: Message) => (message.role === 'toolResult' && message.toolName === 'make_boxes') || (message.role === 'assistant' && message.content.some((block) => block.type === 'toolCall' && block.name === 'make_boxes'));
  const next = baseLead(messages.filter((message) => !isExt(message)));
  const submitting = next.content.some((block) => block.type === 'toolCall' && block.name === 'submit');
  return submitting && !messages.some(isExt) ? fauxAssistantMessage([fauxToolCall('make_boxes', {})], { stopReason: 'toolUse' }) : next;
};
const withProviders = providersTool ? { ...job, workflow: { ...job.workflow, schemas: { ...job.workflow.schemas, Boxed: { type: 'object' } }, root: { ...job.workflow.root, steps: [(job.workflow.root as { steps: unknown[] }).steps[0], { node: 'call', label: 'boxes2', via: 'tool', tool: 'boxes2', args: {}, out: 'Boxed', as: 'boxed', deadline_s: 60 }, ...(job.workflow.root as { steps: unknown[] }).steps.slice(1)] } } } as unknown as typeof job : undefined;
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
// And the agent's own bash tool: before it submits, the lead makes one `bash` call with the command in DEMO_BASH (after its code call when DEMO_CODE is set). The lead never sees that exchange in its own history.
const bashLead = (messages: readonly Message[]) => {
  const isBash = (message: Message) => (message.role === 'toolResult' && message.toolName === 'bash') || (message.role === 'assistant' && message.content.some((block) => block.type === 'toolCall' && block.name === 'bash'));
  const next = (process.env.DEMO_CODE ? codeLead : baseLead)(messages.filter((message) => !isBash(message)));
  const submitting = next.content.some((block) => block.type === 'toolCall' && block.name === 'submit');
  return submitting && !messages.some(isBash) ? fauxAssistantMessage([fauxToolCall('bash', { command: process.env.DEMO_BASH! })], { stopReason: 'toolUse' }) : next;
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
const scripted = { ...fakes, ...(fanning ? { tools: { ...fakes.tools, ...fanning } } : {}), ...(leaking ? { tools: { ...fakes.tools, ...leaking } } : {}), ...(process.env.DEMO_SITES ? { model: sitesLead as typeof fakes.model } : {}), ...(process.env.DEMO_PROVIDERS === 'ext' ? { model: extLead as typeof fakes.model } : process.env.DEMO_BASH ? { model: bashLead as typeof fakes.model } : process.env.DEMO_CODE ? { model: codeLead as typeof fakes.model } : {}), ...(lingering ? { tools: { ...fakes.tools, ...lingering.tools } } : {}), ...(boxTool ? { tools: { ...fakes.tools, ...(lingering?.tools ?? {}), ...boxTool } } : {}), ...(providersTool ? { tools: { ...fakes.tools, ...providersTool } } : {}), ...(judgeCost ? { judge: async (request: Parameters<typeof fakes.judge>[0]) => ({ ...(await fakes.judge(request)), cost_usd: judgeCost }) } : {}) };
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
// And a place of the demo's own beside its tools' boxes (`DEMO_WITH_PLACE`). `labelled` is the local place that also starts a home box (it reports one in `status()`), hands the run's
// process its identity (`HOST_BOX`), which that process claims first, and lets the supervisor read the run's files (`readRunFile` and `listRunFiles`, disk's K8 shape, here over
// its own root): the supervisor reads the label itself. `unclaimed` reports the home box and has the reads but never hands it over, so no process claims it. `unreadable` hands it
// over but its reads fail; `slow` hands it over but its reads answer only after 40 s, past the supervisor's bound on a read. `reporting` reports the home box with no reads and no
// handover; `handing` hands it over with no reads. `disk-local` is the disk package's own `localPlace` (each process `pi-durable-disk run --app` with the harness's
// child app, on the run's directory), with its own run-file reads and no host box. Any other value is the local place, which has neither.
// And a run process that prints a credential-shaped line to its stderr and dies at once (`DEMO_STDERR_SECRET`, in the run's process only): the final-read
// refusal, which names a failed process's own text, must never carry it.
if (process.env.DEMO_STDERR_SECRET && process.env.DEMO_ENTRY) { process.stderr.write(`the tool printed token ${process.env.DEMO_STDERR_SECRET}\nand a plain line after it\n`); process.exit(3); }

const withPlace = process.env.DEMO_WITH_PLACE ? async (context: { paths: { id: string; root: string }; self: string; requestFile: (attempt: number) => string }) => {
  const { localPlace } = await import('@parcha/agentrun-harness');
  const { readFile, readdir } = await import('node:fs/promises');
  const inner = localPlace({ self: context.self, paths: context.paths as never, requestFile: context.requestFile });
  const mode = process.env.DEMO_WITH_PLACE;
  if (mode === 'disk-local') {
    const { localPlace: diskLocalPlace } = await import('@parcha/pi-durable-disk');
    return diskLocalPlace({ app: fileURLToPath(import.meta.resolve('@parcha/agentrun-harness/child-app')) })({ ...context, paths: context.paths as never });
  }
  const from = new Date().toISOString();
  const status = async () => ({ boxes: [{ provider: 'home', kind: 'host', from, to: null }] });
  if (mode === 'reporting') return { ...inner, status };
  // `start-fails` refuses to start a process, with DEMO_START_FAILS_TEXT as its error (a provider's error carries its command's stderr).
  if (mode === 'start-fails') return { ...inner, start: async () => { throw new Error(process.env.DEMO_START_FAILS_TEXT ?? 'the place could not start the process'); } };
  // `start-fails-cause` throws pi-transport's own BoxError, whose CAUSE (a library's original error) holds DEMO_START_FAILS_TEXT; `start-fails-property`
  // throws an error carrying it in a string property of its own (`stderr`).
  if (mode === 'start-fails-cause') {
    const { BoxError } = await import('@parcha/pi-transport');
    return { ...inner, start: async () => { throw new BoxError('unknown', 'the box could not start', new Error(process.env.DEMO_START_FAILS_TEXT ?? 'the library failed')); } };
  }
  // Error shapes a library hands over, each thrown from start with DEMO_START_FAILS_TEXT inside: an error in a nested array (`nested`), a Map as the
  // cause (`map-cause`), a DOMException (`timeout`, as AbortSignal.timeout throws), a cyclic plain object (`cyclic`) and a cause cycle (`cause-cycle`).
  const text = process.env.DEMO_START_FAILS_TEXT ?? '';
  const shapes: Record<string, () => unknown> = {
    'start-fails-nested': () => Object.assign(new Error('the place could not start the process'), { code: 'START_FAILED', errors: [new Error(text)] }),
    'start-fails-map-cause': () => new Error('the place could not start the process', { cause: new Map([['stderr', text]]) }),
    'start-fails-timeout': () => new DOMException(text, 'TimeoutError'),
    'start-fails-cyclic': () => { const details: Record<string, unknown> = { text }; details.self = details; return Object.assign(new Error('the place could not start the process'), { code: 'START_FAILED', details }); },
    'start-fails-cause-cycle': () => { const a = new Error(`first ${text}`); const b = new Error(`second ${text}`, { cause: a }); Object.defineProperty(a, 'cause', { value: b, configurable: true }); return a; },
  };
  if (mode && shapes[mode]) return { ...inner, start: async () => { throw shapes[mode]!(); } };
  // `capture-exit` is the local place, handing the run's process a token only it holds (DEMO_CHILD_ONLY_TOKEN, from DEMO_CHILD_ONLY: the supervisor
  // never tracks it) and keeping each process's exit as the place read it, before any sink, in DEMO_CAPTURE_FILE.
  if (mode === 'capture-exit') return { ...inner, start: async (order: Parameters<typeof inner.start>[0]) => {
    const runner = await inner.start({ ...order, env: { ...order.env, ...(process.env.DEMO_CHILD_ONLY ? { DEMO_CHILD_ONLY_TOKEN: process.env.DEMO_CHILD_ONLY } : {}) } });
    return { ...runner, exited: runner.exited.then((exit) => { if (process.env.DEMO_CAPTURE_FILE) writeFileSync(process.env.DEMO_CAPTURE_FILE, JSON.stringify(exit)); return exit; }) };
  } };
  if (mode === 'start-fails-property') return { ...inner, start: async () => { throw Object.assign(new Error('the place could not start the process'), { code: 'START_FAILED', stderr: process.env.DEMO_START_FAILS_TEXT ?? '' }); } };
  // `handing` hands its home box over but has no reads: its supervisor numbers the box itself, so the process must refuse to claim it (two labellers).
  if (mode === 'handing') return { ...inner, status, start: (order: Parameters<typeof inner.start>[0]) => inner.start({ ...order, env: { ...order.env, HOST_BOX: JSON.stringify({ provider: 'home', key: '0', run: order.env.RUN_LABEL }) } }) };
  // `tapped` (H3) is a place whose host driver makes its host box with the provider the supervisor tapped (`context.hostTap.provider`,
  // a local box here), in an unheld window (`context.hostTap.unheld`, over a K9-shaped window on its own root: create-only puts), runs
  // one command in it, reports it in `status()` (the receipt), lets the supervisor read the run's files, and hands the box to the
  // run's process (`HOST_BOX`), which binds its label. Its box is destroyed when the place lets the run go.
  if (mode === 'tapped') {
    const { localBoxes: boxesHere } = await import('@parcha/pi-transport/box/local');
    const { mkdir, open, readdir: list, readFile: read } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const tap = (context as unknown as { hostTap: { provider<P>(provider: P): P; unheld(run: unknown, start: unknown): Promise<void> } }).hostTap;
    const hostProvider = tap.provider(boxesHere({ root: join(context.paths.root, '..', 'host-boxes') }));
    const made: { box: { id: string; facts(): { gpu: string | null; isolation: string }; destroy(ctx: unknown): Promise<unknown>; exec(command: string[], options: unknown, ctx: unknown): Promise<{ ok: boolean; value?: { wait(): Promise<unknown> } }> }; from: string; to: string | null; key: string }[] = [];
    const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
    const window = {
      signal: new AbortController().signal,
      read: async (path: string) => { try { return new Uint8Array(await read(join(context.paths.root, path))); } catch (error) { if (missing(error)) return null; throw error; } },
      list: async (dir: string) => { try { return (await list(join(context.paths.root, dir))).sort(); } catch (error) { if (missing(error)) return []; throw error; } },
      put: async (path: string, text: string) => {
        await mkdir(dirname(join(context.paths.root, path)), { recursive: true });
        let file;
        try { file = await open(join(context.paths.root, path), 'wx'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error(`${path} exists`), { code: 'EXISTS' }); throw error; }
        try { await file.writeFile(text); } finally { await file.close(); }
      },
    };
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    let recordDir: string | undefined;
    return {
      ...inner,
      start: async (order: Parameters<typeof inner.start>[0]) => {
        recordDir ??= order.env.RECORD_DIR;
        // The window holds the start's provisional box ({ run, index }); the host driver MINTS the box's key at its create (Amendment 2):
        // <run>/<index>/<random nonce>, written as the box's one agentrun-host-key label, handed to its runner, and reported in the status.
        const box = { provider: 'local', key: String(made.length), run: order.env.RUN_LABEL! };
        await tap.unheld(window, { attempt: order.gen, box });
        const key = `${box.run}/${box.key}/${randomBytes(8).toString('hex')}`;
        const created = await (hostProvider as unknown as { create(spec: unknown, ctx: unknown): Promise<{ ok: boolean; value: (typeof made)[number]['box']; error?: unknown }> }).create({ maxLifetimeMs: 600_000, labels: { 'agentrun-host-key': key } }, BACKGROUND_CONTEXT);
        if (!created.ok) throw Object.assign(new Error('the host box could not be made'), { cause: created.error });
        made.push({ box: created.value, from: new Date().toISOString(), to: null, key });
        const ran = await created.value.exec(['true'], undefined, BACKGROUND_CONTEXT);
        if (ran.ok) await ran.value!.wait();
        const entry = made.at(-1)!;
        // `DEMO_PLANT_BOX_LINE` (1 for box-1, or a label): the residue of a crash, a synced line naming that label for a tool box whose label file was lost, already in the recording.
        if (process.env.DEMO_PLANT_BOX_LINE && order.env.RECORD_DIR) {
          await mkdir(join(order.env.RECORD_DIR, '.spool'), { recursive: true });
          writeFileSync(join(order.env.RECORD_DIR, '.spool', 'planted.jsonl'), `${JSON.stringify({ channel: 'live', source: 'transport', kind: 'box.created', gen: 1, t: 0, seq: 0, data: { box: process.env.DEMO_PLANT_BOX_LINE === '1' ? 'box-1' : process.env.DEMO_PLANT_BOX_LINE, provider: 'alpha', facts: { isolation: 'none', cpus: 1, gpu: null } } })}\n`);
        }
        const runner = await inner.start({ ...order, env: { ...order.env, HOST_BOX: JSON.stringify({ ...box, key }) } });
        // `DEMO_HOST_BOX_UNTIL_RELEASE`: the place keeps its host box until it lets the run go (a host driver whose stop is at release).
        if (process.env.DEMO_HOST_BOX_UNTIL_RELEASE) return runner;
        // The host box ends with its process, as a host driver's stop does: before the supervisor hears the process ended.
        return { ...runner, exited: runner.exited.then(async (exit) => { await entry.box.destroy(BACKGROUND_CONTEXT); entry.to = new Date().toISOString(); return exit; }) };
      },
      status: async () => ({ boxes: made.map(({ box, from, to, key }) => ({ provider: 'local', kind: box.facts().gpu ?? box.facts().isolation, from, to, key })) }),
      readRunFile: window.read,
      listRunFiles: window.list,
      release: async () => {
        // `DEMO_RELEASE_MARK`: a file the release writes, saying whether the recording was already finished (its manifest written) when the place was let go.
        if (process.env.DEMO_RELEASE_MARK) writeFileSync(process.env.DEMO_RELEASE_MARK, JSON.stringify({ manifestFirst: recordDir !== undefined && existsSync(join(recordDir, 'manifest.json')) }));
        for (const entry of made) if (entry.to === null) { await entry.box.destroy(BACKGROUND_CONTEXT); entry.to = new Date().toISOString(); }
        await inner.release();
      },
    };
  }
  if (mode !== 'labelled' && mode !== 'unclaimed' && mode !== 'unreadable' && mode !== 'slow') return inner;
  const handOver = (order: Parameters<typeof inner.start>[0]) => (mode !== 'unclaimed' ? { ...order, env: { ...order.env, HOST_BOX: JSON.stringify({ provider: 'home', key: '0', run: order.env.RUN_LABEL }) } } : order);
  // K8's answers over this place's own root: a missing file is null, a missing directory lists nothing.
  const gate = async () => {
    if (mode === 'unreadable') throw new Error('the run files cannot be read here');
    if (mode === 'slow') await new Promise((resolve) => { setTimeout(resolve, 40_000).unref(); });
  };
  const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
  return {
    ...inner,
    start: (order: Parameters<typeof inner.start>[0]) => inner.start(handOver(order)),
    status,
    readRunFile: async (path: string) => { await gate(); try { return new Uint8Array(await readFile(join(context.paths.root, path))); } catch (error) { if (missing(error)) return null; throw error; } },
    listRunFiles: async (dir: string) => { await gate(); try { return (await readdir(join(context.paths.root, dir))).sort(); } catch (error) { if (missing(error)) return []; throw error; } },
  };
} : undefined;

export const options = { ...(process.env.DEMO_FOLLOW_HOLD_MS ? { followHoldMs: Number(process.env.DEMO_FOLLOW_HOLD_MS) } : {}), ...(process.env.DEMO_CODE_ON ? { codeMode: true } : {}), ...(process.env.DEMO_ITEM ? { itemOf: (path: string) => `scan ${path}` } : {}), self: import.meta.url, spec, job: withReport(withProviders ?? withBox ?? withFan ?? withLeak ?? withSites ?? lingering?.job ?? job), fakes: { ...scriptedHeld, ...(process.env.DEMO_FAKES_INPUT ? { input: { company: 'Beta Ltd' } } : {}), ...(probe ? { vision: probe } : eyes ? { vision: ownLane } : transcribing ? { vision: transcribing } : {}), ...(eyes ? { lead: { input: ['text' as const] } } : {}) }, ...(result ? { result } : {}), ...(live ? { live } : {}), ...(manifest ? { manifest } : {}), ...(sourcesFor ? { sourcesFor } : {}), ...(providers ? { providers } : {}), ...(providerExtensions ? { providerExtensions } : {}), ...(process.env.DEMO_RESULT_THROWS ? { result: () => { throw new Error(process.env.DEMO_RESULT_THROWS_TEXT ?? 'the result hook failed'); } } : {}), ...(withPlace ? { place: withPlace } : {}) };
if (process.argv.includes('--child')) await demo(options);
