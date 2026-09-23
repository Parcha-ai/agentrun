import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compile } from 'typebox/compile';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import agentRunExtension, { createAgentRunExtension } from '../dist/extension.js';
import { demoWorkflow } from '../dist/demo.js';
import { authorSkillDirectory } from '@parcha/agentrun-dsl';
import { supportTriageWorkflow, supportTriageInputs, scriptedSupportTriageDeps } from '../dist/triage-demo.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const waitUntil = async predicate => { while (!predicate()) await new Promise(resolve => setImmediate(resolve)); };
const resultSchema = { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string' } } };
const workflow = root => ({ v: 2, name: 'Read a local note', schemas: { Result: resultSchema }, output: { schemaId: 'Result', path: 'result' }, root: root ?? { node: 'agent', label: 'read-note', instructions: 'Read the supplied file with read and submit its exact text.', tools: ['read'], out: 'Result', as: 'result' } });

async function harness({ cwd = process.cwd(), responses = [], activeTools = ['read'], tokensPerSecond = Infinity, withModel = true, hasUI = false, mode = hasUI ? 'tui' : 'print', branch = [], extensionOptions } = {}) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond }); faux.setResponses(responses); runtime.registerNativeProvider(faux.provider);
  const registry = new ModelRegistry(runtime), calls = [], messages = [], prompts = [], statuses = [], widgets = [], commands = new Map(), tools = new Map(), events = new Map();
  const entered = deferred(); const controller = new AbortController();
  const ctx = { cwd, model: withModel ? faux.getModel() : undefined, thinkingLevel: 'low', signal: controller.signal, hasUI, mode,
    sessionManager: { getSessionId: () => 'native-extension-test', getBranch: () => branch, getSessionFile: () => undefined },
    ui: { setStatus: (name, value) => statuses.push({ name, value }), setWidget: (name, value) => widgets.push({ name, value }), custom: async () => undefined },
    modelRegistry: {
      getAll: () => registry.getAll(),
      streamSimple(model, transcript, options) { calls.push({ model, transcript, options }); entered.resolve(); return registry.streamSimple(model, transcript, options); },
    },
  };
  const pi = {
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    registerEntryRenderer: () => {}, appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    on: (name, handler) => events.set(name, handler),
    getActiveTools: () => activeTools,
    getCommands: () => [{name: 'skill:agentrun-author', source: 'skill'}],
    getAllTools: () => [...['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'].map(name => ({ name, sourceInfo: { source: 'builtin' } })), { name: 'custom_search', sourceInfo: { source: 'extension' } }],
    getThinkingLevel: () => 'low',
    sendMessage: message => messages.push(message), sendUserMessage: (text, options) => prompts.push({ text, options }),
  };
  (extensionOptions === undefined ? agentRunExtension : createAgentRunExtension(extensionOptions))(pi);
  return { ctx, pi, calls, messages, prompts, statuses, widgets, commands, tools, events, faux, entered, branch,
    command: args => commands.get('agentrun').handler(args, ctx),
    tool: (args, update) => tools.get('agentrun').execute('test-call', args, controller.signal, update, ctx),
    shutdown: () => events.get('session_shutdown')(),
  };
}

test('support triage preserves decisions, named reuse and branch-local receipts across new hosts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-procedure-'));
  const first = await harness({ cwd, withModel: false });
  let second;
  try {
    await first.command('triage billing');
    const run = first.messages.at(-1).details;
    assert.equal(run.status, 'complete'); assert.equal(run.output.queue, 'billing');
    const decision = run.view.nodes.find(node => node.kind === 'route');
    assert.match(decision.details.join('\n'), /Fictional ledger/);
    assert.match(decision.details.join('\n'), /Interpreter accepted/);
    await first.command('save support-triage');
    assert.match(first.messages.at(-1).content, /Input and execution permission are not saved/);
    const originalBranch = structuredClone(first.branch);
    await first.shutdown();
    second = await harness({ cwd, withModel: false, branch: originalBranch });
    await second.command('inspect');
    assert.match(second.messages.at(-1).content, /complete/);
    await second.command('history 1');
    assert.equal(second.messages.at(-1).details.run.report.output.queue, 'billing');
    const restored = await second.tool({ action: 'inspect' });
    assert.equal(restored.details.inspection.name, supportTriageWorkflow.name);
    await second.command(`input ${JSON.stringify(supportTriageInputs.technical)}`);
    await second.command('run');
    assert.equal(second.messages.at(-1).details.output.queue, 'technical');
    assert.equal(second.messages.at(-1).details.calls.agent, 1);
    assert.equal(second.calls.length, 0, 'scripted session restoration does not silently switch to live');
    await second.command('history');
    assert.equal(second.messages.at(-1).details.runs.length, 2);
    await second.command('load support-triage');
    assert.match(second.messages.at(-1).content, /Missing input: ticket, evidence/);
    assert.match(second.messages.at(-1).content, /live adapters/);
    assert.equal(second.calls.length, 0, 'loading does not execute');
    assert.equal(second.branch.at(-1).data.demo, undefined);
    assert.deepEqual(second.branch.at(-1).data.input, {});
  } finally { await second?.shutdown(); await first.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('saved procedure loads in an empty session and uses only current host tools and judge', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-new-session-'));
  const first = await harness({ cwd, withModel: false });
  let second;
  try {
    await first.tool({ action: 'inspect', workflow: supportTriageWorkflow, input: supportTriageInputs.billing });
    await first.tool({ action: 'save', name: 'triage' }); await first.shutdown();
    second = await harness({ cwd, extensionOptions: { createJudge: () => scriptedSupportTriageDeps().runJudge } });
    const loaded = await second.tool({ action: 'load', name: 'triage', input: supportTriageInputs.billing });
    assert.equal(loaded.details.inspection.sha256.length, 64);
    const run = await second.tool({ action: 'run' });
    assert.equal(run.details.status, 'complete'); assert.equal(run.details.output.queue, 'billing');
    assert.equal(run.details.calls.agent, 0);
    assert(!JSON.stringify(second.branch).includes('executableAuthorized'));
  } finally { await second?.shutdown(); await first.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('RPC inspection is readable and never attempts a custom TUI', async () => {
  const app = await harness({ withModel: false, hasUI: true, mode: 'rpc' });
  app.ctx.ui.custom = async () => { throw new Error('RPC cannot show native custom UI'); };
  try {
    await app.command('triage ambiguous');
    assert.equal(app.messages.at(-1).details.status, 'escalated');
    await app.command('inspect');
    assert.match(app.messages.at(-1).content, /choose-support-route/);
    await app.command('history 1');
    assert.equal(app.messages.at(-1).details.run.report.status, 'escalated');
  } finally { await app.shutdown(); }
});

test('one-string natural input is stored verbatim without an authoring call', async () => {
  const app = await harness();
  try {
    const definition = workflow();
    definition.schemas.Input = { type: 'object', properties: { note: { type: 'string', minLength: 1 } },
      required: ['note'], additionalProperties: false };
    definition.input = { schemaId: 'Input' };
    await app.tool({ action: 'inspect', workflow: definition });
    await app.command('input It broke after the change.');
    assert.deepEqual(app.branch.at(-1).data.input, { note: 'It broke after the change.' });
    assert.equal(app.prompts.length, 0);
    assert.match(app.messages.at(-1).content, /Nothing was run/);

    await app.tool({ action: 'inspect', workflow: supportTriageWorkflow });
    await app.command('input A different support case');
    assert.equal(app.prompts.length, 1, 'multi-field input still asks Pi to map the case');
  } finally { await app.shutdown(); }
});

test('history is read-only and branch navigation cannot restore sibling history', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.command('triage failure');
    assert.equal(app.messages.at(-1).details.status, 'failed');
    await app.command('history 1');
    assert.equal(app.messages.at(-1).details.run.report.status, 'failed');
    app.ctx.sessionManager.getBranch = () => [];
    await app.events.get('session_tree')({}, app.ctx);
    await app.command('history'); assert.match(app.messages.at(-1).content, /No retained runs/);
    await app.command('inspect'); assert.match(app.messages.at(-1).content, /Describe a task/);
  } finally { await app.shutdown(); }
});

test('native tool declares object-valued workflows and rejects encoded JSON without changing the staged draft', async () => {
  const app = await harness({ withModel: false });
  try {
    const tool = app.tools.get('agentrun'), validate = Compile(tool.parameters);
    assert.equal(tool.parameters.properties.workflow.type, 'object');
    assert.match(tool.parameters.properties.workflow.description, /not a JSON-encoded string/);
    assert(validate.Check({ action: 'describe' }));
    assert(validate.Check({ action: 'run' }));
    const definition = workflow();
    assert(validate.Check({ action: 'inspect', workflow: definition, input: { question: 'Fictional original' } }));
    const before = await app.tool({ action: 'inspect', workflow: definition, input: { question: 'Fictional original' } });
    for (const invalid of [JSON.stringify(definition), [], null, 42, true]) {
      assert.equal(validate.Check({ action: 'inspect', workflow: invalid }), false);
      await assert.rejects(app.tool({ action: 'inspect', workflow: invalid, input: { question: 'Must not replace' } }), /workflow must be a JSON object/);
      assert.equal((await app.tool({ action: 'inspect' })).details.inspection.sha256, before.details.inspection.sha256);
    }
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('native extension has one workflow tool and a task-first command without adapter setup', async () => {
  const app = await harness({ activeTools: ['read', 'custom_search'] });
  try {
    assert.deepEqual([...app.tools.keys()], ['agentrun']); assert.deepEqual([...app.commands.keys()], ['agentrun']);
    await app.command(''); assert.match(app.messages.at(-1).content, /Describe a task/);
    await app.command('Review the release notes and summarize missing migration steps');
    assert.equal(app.prompts.length, 1);
    assert.equal(app.prompts[0].text, '/skill:agentrun-author Review the release notes and summarize missing migration steps');
    assert.equal(app.prompts[0].options.expandPromptTemplates, true);
    const described = await app.tool({ action: 'describe' });
    assert.deepEqual(described.details.tools.map(tool => tool.name), ['search', 'support_demo_lookup', 'support_demo_handoff', 'read']);
    assert.ok(described.details.tools.every(tool => tool.parameters));
    assert.deepEqual(described.details.limits, { deadlineMs: 600000, modelRequests: 50, judgeCalls: 100, toolAttempts: 100,
      nodeMaxTurns: 8, nodeMaxSubmissions: 3, nodeTimeoutMs: 120000 });
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('demo displays the real graph and executes the real interpreter without model transport', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.command('demo');
    assert.ok(app.messages.some(message => /\[map\]/.test(message.content)));
    const result = app.messages.at(-1);
    assert.match(result.content, /Scripted demo: complete/);
    assert.equal(result.details.mode, 'scripted'); assert.equal(result.details.status, 'complete');
    assert.deepEqual(result.details.calls, { agent: 5, judge: 3, tool: 3 });
    assert.equal(result.details.output.findings.length, 3);
    assert.ok(result.details.events.some(event => event.type === 'judge.answered'));
    assert.equal(app.calls.length, 0);
    await app.command(''); assert.match(app.messages.at(-1).content, /scripted · fictional · no model calls/);
  } finally { await app.shutdown(); }
});

test('empty-evidence demo escalates without fabricated findings or writer calls', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.command('demo empty');
    const report = app.messages.at(-1).details;
    assert.equal(report.status, 'escalated'); assert.equal(report.output, undefined);
    assert.equal(report.calls.agent, 1); assert.ok(report.escalation.summary.length);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('inspect then run uses the actual native Agent, selected faux transport and enabled read tool', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-native-read-'));
  const note = 'A cedar tree marks the north entrance.';
  await writeFile(join(cwd, 'note.txt'), note);
  const app = await harness({ cwd, responses: [
    fauxAssistantMessage(fauxToolCall('read', { path: 'note.txt' })),
    transcript => { assert.match(JSON.stringify(transcript.messages), /A cedar tree marks the north entrance/); return fauxAssistantMessage(fauxToolCall('submit', { value: { content: note } })); },
  ] });
  try {
    const definition = workflow();
    const inspected = await app.tool({ action: 'inspect', workflow: definition });
    assert.match(inspected.content[0].text, /read-note \[agent\]/); assert.equal(app.calls.length, 0);
    definition.root.instructions = 'Changed by caller after inspection';
    const updates = [];
    const result = await app.tool({ action: 'run', input: { path: 'note.txt' } }, update => updates.push(update));
    assert.equal(result.details.status, 'complete'); assert.deepEqual(result.details.output, { content: note });
    assert.equal(result.details.calls.agent, 1); assert.equal(app.calls.length, 2);
    assert.ok(updates.some(update => /read-note/.test(update.content[0].text)));
    assert.ok(updates.some(update => /600-second/.test(update.content[0].text))); 
    for (const call of app.calls) { assert.equal(call.model, app.ctx.model); assert.equal(call.options.reasoning, 'low'); }
    assert.doesNotMatch(JSON.stringify(app.calls[0].transcript), /Changed by caller/);
  } finally { await app.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('missing active model cannot select a fallback even when registry contains a model', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.tool({ action: 'inspect', workflow: workflow() });
    await assert.rejects(app.tool({ action: 'run', input: {} }), /active Pi model/);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('untrusted code is inspectable but only a user command can authorize its exact snapshot', async () => {
  const app = await harness({ withModel: false });
  globalThis.__nativeExtensionProbe = 0;
  const definition = workflow({ node: 'code', label: 'transform', code: '((function(){}).constructor("globalThis.__nativeExtensionProbe++")(), s => ({result:{content:"computed"}}))' });
  try {
    const inspected = await app.tool({ action: 'inspect', workflow: definition, input: { question: 'A generic task' } });
    assert.equal(inspected.details.inspection.checked, 'structure-only');
    assert.equal(globalThis.__nativeExtensionProbe, 0);
    await assert.rejects(app.tool({ action: 'run', input: {}, trusted: true }), /allowExecutableCandidates/);
    assert.equal(globalThis.__nativeExtensionProbe, 0);
    await app.command('run --trusted');
    assert.equal(app.messages.at(-1).details.status, 'complete'); assert.deepEqual(app.messages.at(-1).details.output, { content: 'computed' });
    assert.ok(globalThis.__nativeExtensionProbe > 0); assert.equal(app.calls.length, 0);
    await app.tool({ action: 'inspect', workflow: definition });
    await assert.rejects(app.tool({ action: 'run', input: {} }), /allowExecutableCandidates/);
  } finally { await app.shutdown(); delete globalThis.__nativeExtensionProbe; }
});

test('native inspection rejects mechanical errors without executing Math IIFEs or replacing the staged draft', async () => {
  const app = await harness({ withModel: false });
  Math.__nativeSafeFactory = 0;
  Math.__nativeSafeBody = 0;
  const original = workflow({ node: 'code', label: 'trusted-only',
    code: '(() => { Math.__nativeSafeFactory++; return s => { Math.__nativeSafeBody++; return {result:{content:s.question}}; }; })()' });
  try {
    const inspected = await app.tool({ action: 'inspect', workflow: original, input: { question: 'Original fictional input' } });
    assert.equal(inspected.details.inspection.checked, 'structure-only');
    assert.equal(Math.__nativeSafeFactory, 0);
    assert.equal(Math.__nativeSafeBody, 0);
    const malformed = [
      workflow({ node: 'code', label: 'raw-body', code: 'return {result:{content:"invalid"}};' }),
      workflow({ node: 'code', label: 'unknown-fields', code: 's => ({})', state: {}, out: 'Result' }),
      { ...original, schemas: { ...original.schemas, Records: { type: 'array', items: { $ref: 'Result' } } } },
      { ...original, schemas: { ...original.schemas, Check: { type: 'object', properties: {
        supported: { type: 'boolean', description: 'Does this fictional claim have support?' } } } },
        root: { node: 'judge', label: 'unknown-judge-field', out: 'Check', as: 'result', instructions: 'Invalid field' } },
    ];
    for (const candidate of malformed) {
      await assert.rejects(app.tool({ action: 'inspect', workflow: candidate, input: { question: 'Must not replace input' } }), /Cannot inspect workflow/);
      assert.equal((await app.tool({ action: 'inspect' })).details.inspection.sha256, inspected.details.inspection.sha256);
      assert.equal(Math.__nativeSafeFactory, 0);
      assert.equal(Math.__nativeSafeBody, 0);
    }
    await assert.rejects(app.tool({ action: 'run' }), /allowExecutableCandidates/);
    assert.equal(Math.__nativeSafeFactory, 0);
    await app.command('run --trusted');
    assert.equal(app.messages.at(-1).details.status, 'complete');
    assert.equal(app.messages.at(-1).details.output.content, 'Original fictional input');
    assert.ok(Math.__nativeSafeFactory > 0);
    assert.ok(Math.__nativeSafeBody > 0);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); delete Math.__nativeSafeFactory; delete Math.__nativeSafeBody; }
});

test('inactive and custom extension tools are refused before the native model is called', async () => {
  const app = await harness({ activeTools: ['custom_search'] });
  try {
    await assert.rejects(app.tool({ action: 'inspect', workflow: workflow() }), /registered/);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('native inspect rejects host structural limits atomically and describe advertises them', async () => {
  const app = await harness();
  try {
    const original = workflow();
    await app.tool({ action: 'inspect', workflow: original });
    const described = await app.tool({ action: 'describe' });
    assert.deepEqual(described.details.structuralLimits, { maxNodes: 200, maxMapConcurrency: 8, maxParallelBranches: 8 });
    const tooWide = workflow({ node: 'parallel', label: 'nine', branches: Array.from({ length: 9 }, (_, i) => ({ ...original.root, label: `a${i}`, as: `a${i}` })) });
    await assert.rejects(app.tool({ action: 'inspect', workflow: tooWide, input: { changed: true } }), /8 branches/);
    const retained = await app.tool({ action: 'inspect' });
    assert.equal(retained.details.inspection.sha256, (await app.tool({ action: 'inspect', workflow: original })).details.inspection.sha256);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('native code diagnostics support inspect, trusted run, repair and rerun without exposing thrown text', async () => {
  const app = await harness({ withModel: false });
  try {
    const broken = workflow({ node: 'code', label: 'format-result', code: 's => { throw new Error("private-adapter-body"); }' });
    await app.tool({ action: 'inspect', workflow: broken });
    await app.command('run --trusted');
    const failed = app.messages.at(-1);
    assert.equal(failed.details.error.code, 'code_transform_failed');
    assert.match(failed.content, /format-result/); assert.doesNotMatch(failed.content, /private-adapter-body/);
    broken.root.code = 's => ({result:{content:"Fictional repaired fixture"}})';
    await app.tool({ action: 'inspect', workflow: broken });
    await assert.rejects(app.tool({ action: 'run' }), /allowExecutableCandidates/);
    await app.command('run --trusted');
    assert.equal(app.messages.at(-1).details.status, 'complete'); assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('explicit empty tools reaches the real native child as submit-only', async () => {
  const app = await harness({ activeTools: ['read'], responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'Fictional extraction' } }))] });
  try {
    const definition = workflow(); definition.root.tools = [];
    await app.tool({ action: 'inspect', workflow: definition });
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete');
    assert.deepEqual(app.calls[0].transcript.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? []).map(tool => tool.name), ['submit']);
  } finally { await app.shutdown(); }
});

for (const termination of ['stop', 'shutdown']) {
  test(`${termination} cancels native streaming and prevents late session notifications`, { timeout: 10_000 }, async () => {
    const app = await harness({ hasUI: true, tokensPerSecond: 1, responses: [fauxAssistantMessage('This reply deliberately continues streaming until the workflow is cancelled.')] });
    try {
      await app.tool({ action: 'inspect', workflow: workflow() });
      await app.command('run'); await app.entered.promise;
      if (termination === 'stop') await app.command('stop'); else await app.shutdown();
      if (termination === 'stop') await waitUntil(() => app.messages.some(message => message.details?.status === 'interrupted'));
      assert.equal(app.statuses.at(-1)?.name, 'agentrun');
      assert.equal(app.statuses.at(-1)?.value, undefined, 'termination explicitly clears the originating status');
      const count = app.messages.length, statusCount = app.statuses.length;
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(app.messages.length, count); assert.equal(app.statuses.length, statusCount);
      assert.equal(app.calls.length, 1); assert.equal(app.calls[0].options.signal.aborted, true);
      if (termination === 'stop') assert.equal(app.messages.at(-1).details.status, 'interrupted');
      else {
        assert.equal(app.messages.length, 0);
        app.ctx.mode = 'print'; await app.command('inspect');
        assert.match(app.messages.at(-1).content, /interrupted/);
        assert.equal(app.calls.length, 1, 'restoring the same session never restarts interrupted work');
      }
    } finally { await app.shutdown(); }
  });
}


test('switching sessions clears the originating status and cannot deliver the old workflow result', { timeout: 10_000 }, async () => {
  const app = await harness({ hasUI: true, tokensPerSecond: 1, responses: [fauxAssistantMessage('This old session response is cancelled during a switch.')] });
  try {
    await app.tool({ action: 'inspect', workflow: workflow() });
    await app.command('run');
    await app.entered.promise;
    assert.ok(app.statuses.at(-1).value, 'the old workflow has an active status');
    await app.events.get('session_before_switch')({}, app.ctx);
    assert.equal(app.statuses.at(-1).value, undefined);
    assert.equal(app.messages.length, 0, 'session event alone prevents old results without another AgentRun command');
    app.ctx.sessionManager.getSessionId = () => 'next-native-session';
    app.ctx.sessionManager.getBranch = () => [];
    await app.command('');
    assert.equal(app.messages.length, 1); assert.match(app.messages[0].content, /Describe a task/);
    assert.equal(app.calls[0].options.signal.aborted, true);
    const count = app.messages.length;
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(app.messages.length, count);
  } finally { await app.shutdown(); }
});

test('run refuses an inline definition so the inspected graph cannot be silently replaced', async () => {
  const app = await harness({ responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'original' } }))] });
  try {
    await assert.rejects(app.tool({ action: 'run', workflow: workflow(), input: {} }), /inspect/i);
    assert.equal(app.calls.length, 0);
    const original = workflow(); await app.tool({ action: 'inspect', workflow: original });
    const replacement = workflow(); replacement.name = 'Replacement that was never shown';
    await assert.rejects(app.tool({ action: 'run', workflow: replacement, input: {} }), /inspect/i);
    const current = await app.tool({ action: 'inspect' });
    assert.equal(current.details.inspection.name, original.name);
    const result = await app.tool({ action: 'run', input: {} });
    assert.equal(result.details.status, 'complete'); assert.equal(app.calls.length, 1);
  } finally { await app.shutdown(); }
});

test('default tool inventory is read-only and shell declarations cannot bypass host admission', async () => {
  const app = await harness({ activeTools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'] });
  try {
    const definition = workflow(); definition.root.tools = ['bash'];
    const inspected = await app.tool({ action: 'inspect', workflow: definition });
    assert.deepEqual([...inspected.details.tools].sort(), ['find', 'grep', 'ls', 'read', 'search', 'support_demo_handoff', 'support_demo_lookup']);
    await assert.rejects(app.tool({ action: 'run', input: {}, trusted: true }), /registered/);
    assert.equal(app.calls.length, 0);
    await app.command('Summarize this repository');
    assert.doesNotMatch(app.prompts.at(-1).text, /Available child\/effect tools:[^\n]*(?:bash|edit|write)/);
  } finally { await app.shutdown(); }
});

test('only a user trusted command can enable an active write tool, and permission expires afterwards', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-native-trusted-'));
  const app = await harness({ cwd, activeTools: ['read', 'write'], responses: [
    transcript => { assert.match(JSON.stringify(transcript.messages), /exact-inspected-input/); return fauxAssistantMessage(fauxToolCall('write', { path: 'approved.txt', content: 'Explicitly authorized test write.' })); },
    fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'Written.' } })),
  ] });
  try {
    const definition = workflow(); definition.root.tools = ['write']; definition.root.instructions = 'Write approved.txt with the authorized test text and submit completion.';
    await app.tool({ action: 'inspect', workflow: definition, input: { marker: 'exact-inspected-input' } });
    await assert.rejects(app.tool({ action: 'run', input: { marker: 'rejected-input-must-not-replace-inspected-input' } }), /registered/);
    assert.equal(app.calls.length, 0); await assert.rejects(readFile(join(cwd, 'approved.txt')), { code: 'ENOENT' });
    await app.command('run --trusted');
    assert.equal(app.messages.at(-1).details.status, 'complete');
    assert.equal(await readFile(join(cwd, 'approved.txt'), 'utf8'), 'Explicitly authorized test write.');
    assert.equal(app.calls.length, 2);
    await assert.rejects(app.tool({ action: 'run', input: {} }), /registered/);
    assert.equal(app.calls.length, 2, 'trusted execution does not grant later model-tool permission');
  } finally { await app.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('a workflow requiring Jev fails configuration before any earlier Pi agent call', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const app = await harness({ responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'No call should be spent.' } }))] });
  try {
    const definition = workflow({ node: 'chain', steps: [workflow().root,
      { node: 'judge', label: 'review', state: { evidence: '{result.content}' }, out: 'Decision', as: 'decision' },
    ] });
    definition.schemas.Decision = { type: 'object', additionalProperties: false, required: ['supported'], properties: { supported: { type: 'boolean', description: 'Does the evidence support the claim?' } } };
    definition.output = { schemaId: 'Decision', path: 'decision' };
    await app.tool({ action: 'inspect', workflow: definition });
    await assert.rejects(app.tool({ action: 'run', input: {} }), /Jev|TypeSafe|configuration/i);
    assert.equal(app.calls.length, 0);
    assert.equal(app.statuses.at(-1)?.value, undefined);
  } finally {
    await app.shutdown();
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prior;
  }
});


test('a direct builtin read runs without an agent and validates the actual Pi result envelope', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-native-direct-'));
  const note = 'The migration guide needs an upgrade command.';
  await writeFile(join(cwd, 'note.txt'), note);
  const app = await harness({ cwd, withModel: false });
  try {
    const definition = workflow({ node: 'call', label: 'read-note', via: 'tool', tool: 'read', args: { path: 'note.txt' }, out: 'Result', as: 'result', deadline_s: 5 });
    definition.schemas.Result = { type: 'object', required: ['content'], properties: {
      content: { type: 'array', items: { type: 'object', required: ['type', 'text'], properties: { type: { const: 'text' }, text: { type: 'string' } } } },
      details: {},
    } };
    await app.tool({ action: 'inspect', workflow: definition });
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete', JSON.stringify(result.details));
    assert.deepEqual(result.details.output.content, [{ type: 'text', text: note }]);
    assert.deepEqual(result.details.calls, { agent: 0, judge: 0, tool: 1 });
    assert.equal(app.calls.length, 0);
    definition.schemas.Result = resultSchema;
    await app.tool({ action: 'inspect', workflow: definition });
    const wrongSchema = await app.tool({ action: 'run' });
    assert.equal(wrongSchema.details.status, 'failed');
    assert.ok(wrongSchema.details.error, 'schema mismatch is reported instead of accepting the wrong envelope');
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});


test('missing packaged skill gives a recovery step without dispatching an unexpanded prompt', async () => {
  const app = await harness();
  try {
    app.pi.getCommands = () => [];
    await app.command('Review a note');
    assert.equal(app.prompts.length, 0);
    assert.match(app.messages.at(-1).content, /Enable package skills, then \/reload/);
  } finally { await app.shutdown(); }
});

test('status describes readiness without credentials, network access or a model identifier', async () => {
  const app = await harness();
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'fake-test-key';
  try {
    await app.command('status');
    const message = app.messages.at(-1);
    assert.match(message.content, /Skill: loaded/);
    assert.match(message.content, /connection not tested/);
    assert.doesNotMatch(message.content, /fake-test-key/);
    assert.equal(message.details.pi, true);
    assert.equal(app.calls.length, 0);
    const missing = { ...app.ctx, model: undefined };
    await app.commands.get('agentrun').handler('status', missing);
    assert.match(app.messages.at(-1).content, /no usable active model/);
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved;
    await app.shutdown();
  }
});

test('progress widget separates success and failure, renders readable findings and clears after a run', async () => {
  const app = await harness({ withModel: false, hasUI: true });
  try {
    await app.command('demo');
    await waitUntil(() => app.messages.some(message => message.details?.status));
    assert.ok(app.widgets.some(({ value }) => value?.some(line => /succeeded.*failed/.test(line))));
    assert.equal(app.widgets.at(-1).value, undefined);
    assert.match(app.messages.at(-1).content, /findings:/);
    assert.doesNotMatch(app.messages.at(-1).content, /"findings"\s*:/);
    assert.equal(app.messages.at(-1).details.output.findings.length, 3);
  } finally { await app.shutdown(); }
});

test('model-facing tool output retains the complete result while the display stays compact', async () => {
  const content = 'evidence '.repeat(2200) + 'REQUIRED-FINAL-DETAIL\u202e\u0085';
  const app = await harness({ responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content } }))] });
  try {
    await app.tool({ action: 'inspect', workflow: workflow() });
    const result = await app.tool({ action: 'run' });
    assert.equal(JSON.parse(result.content[0].text).output.content, content);
    const display = app.tools.get('agentrun').renderResult(result).render(90).join('\n');
    assert.match(display, /Full output is in the structured result/);
    assert.ok(display.length < result.content[0].text.length);
    const expanded = app.tools.get('agentrun').renderResult(result, { expanded: true }).render(90).join('\n');
    assert.match(expanded, /REQUIRED-FINAL-DETAIL/);
  } finally { await app.shutdown(); }
});

test('tool-set refresh reserves the run before awaiting disposal', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agentrun-run-race-'));
  await writeFile(join(cwd, 'note.txt'), 'One admitted read.');
  const activeTools = [];
  const app = await harness({ cwd, activeTools, withModel: false });
  try {
    const definition = JSON.parse(await readFile(join(authorSkillDirectory(), 'examples/read-file.json'), 'utf8'));
    await app.tool({ action: 'describe' }); // Create a session before the host tool-set changes.
    activeTools.push('read');
    await app.tool({ action: 'inspect', workflow: definition, input: { path: 'note.txt' } });
    await Promise.all([app.command('run'), app.command('run')]);
    assert.equal(app.messages.filter(message => message.details?.status === 'complete').length, 1);
    assert.ok(app.messages.some(message => /already running/.test(message.content)));
  } finally { await app.shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('native SOP requirements fail before provider access without dropping the rubric', async () => {
  const app = await harness();
  try {
    const definition = workflow();
    await app.tool({ action: 'inspect', workflow: definition });
    definition.root.sopSection = ['Blockers', 'Corrections'];
    await assert.rejects(app.tool({ action: 'inspect', workflow: definition }), /Native Pi does not supply SOP text/);
    assert.equal(app.calls.length, 0);
    const inspected = await app.tool({ action: 'inspect' });
    assert.deepEqual(inspected.details.inspection.requires.sopSections, []);
    assert.deepEqual(definition.root.sopSection, ['Blockers', 'Corrections']);
    await app.command('status');
    assert.equal(app.messages.at(-1).details.running, false);
    assert.equal(app.messages.at(-1).details.sop, false);
  } finally { await app.shutdown(); }
});


test('demo reruns preserve scripted success and missing-evidence modes through slash and model tools', async () => {
  const app = await harness({ withModel: false });
  try {
    for (const [command, expected] of [['demo', 'complete'], ['demo empty', 'escalated']]) {
      await app.command(command);
      await app.command('run');
      assert.equal(app.messages.at(-1).details.status, expected);
      assert.equal(app.messages.at(-1).details.mode, 'scripted');
      const replay = await app.tool({ action: 'run' });
      assert.equal(replay.details.status, expected);
      assert.equal(replay.details.mode, 'scripted');
      assert.equal(JSON.parse(replay.content[0].text).mode, 'scripted');
    }
    assert.equal(app.calls.length, 0);
    await app.command('demo live');
    assert.match(app.messages.at(-1).content, /active Pi model/);
    assert.match(app.messages.at(-1).content, /\/model/);
    assert.equal(app.calls.length, 0);
    const described = await app.tool({ action: 'describe' });
    assert.equal(described.details.running, false);
  } finally { await app.shutdown(); }
});

test('replacing a demo clears scripted transport and old input, while inspecting the same draft retains both', async () => {
  const app = await harness({ responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'authored' } }))] });
  try {
    await app.command('demo');
    await app.tool({ action: 'inspect', workflow: structuredClone(demoWorkflow) });
    const replay = await app.tool({ action: 'run' });
    assert.equal(replay.details.mode, 'scripted');
    await app.tool({ action: 'inspect', input: { question: 'oldWorkflowOnly should not leak' } });
    await app.tool({ action: 'inspect', workflow: workflow() });
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.mode, 'live');
    assert.equal(result.details.status, 'complete');
    assert.deepEqual(result.details.output, { content: 'authored' });
    assert.equal(app.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(app.calls[0].transcript), /oldWorkflowOnly|should not leak/);
  } finally { await app.shutdown(); }
});

test('status keeps offline readiness separate from provider availability and remains read-only', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.command('status');
    assert.match(app.messages.at(-1).content, /Demo: ready/);
    assert.match(app.messages.at(-1).content, /\/login.*\/model/);
    assert.equal(app.messages.at(-1).details.workflow, false);
    assert.equal(app.calls.length, 0);
    await app.command('demo');
    await app.command('status');
    assert.match(app.messages.at(-1).content, /Workflow: .*scripted/);
    assert.equal(app.messages.at(-1).details.workflow, true);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});


test('authoring without a usable model gives recovery before dispatching a task', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.command('Find cancellation gaps in this repository');
    assert.match(app.messages.at(-1).content, /\/login.*\/model/);
    assert.equal(app.prompts.length, 0);
    assert.equal(app.calls.length, 0);
    assert.match(app.messages.at(-1).content, /\/login.*\/model/);
    assert.match(app.messages.at(-1).content, /\/agentrun demo/);
    await app.command('demo');
    assert.equal(app.messages.at(-1).details.status, 'complete');
  } finally { await app.shutdown(); }
});


test('help and mistyped demo commands never dispatch an authoring prompt or replace the current workflow', async () => {
  const app = await harness();
  try {
    await app.command('Demo');
    const draft = (await app.tool({ action: 'inspect' })).details.inspection.sha256;
    for (const command of ['help', '--help', 'HELP', 'demo-live', 'demo --live', 'run --trust', 'status --extra']) {
      await app.command(command);
      assert.match(app.messages.at(-1).content, /Describe a task/);
      assert.equal((await app.tool({ action: 'inspect' })).details.inspection.sha256, draft);
    }
    assert.equal(app.calls.length, 0);
    assert.equal(app.prompts.length, 0);
    const tasks = ['Run a review of cancellation behavior', 'Compare cancellation handling in runtime and tests', 'Help me review this repository', 'Benchmark the parser against a plain loop', 'Stop duplicate notifications without dropping events', 'Demo this repository for a new developer', 'Status reporting should include the failing node'];
    for (const task of tasks) await app.command(task);
    assert.deepEqual(app.prompts.map(prompt => prompt.text), tasks.map(task => `/skill:agentrun-author ${task}`));
    await app.command('RUN   --trusted');
    assert.equal(app.messages.at(-1).details.mode, 'scripted');
    assert.equal(app.messages.at(-1).details.status, 'complete');
  } finally { await app.shutdown(); }
});


test('reinspecting the same authored definition preserves its input and escapes its name in status', async () => {
  const app = await harness({ responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'retained' } }))] });
  try {
    const definition = workflow();
    definition.name = 'research\nForged status: complete';
    await app.tool({ action: 'inspect', workflow: definition, input: { note: 'retain-this-input' } });
    await app.tool({ action: 'inspect', workflow: structuredClone(definition) });
    await app.command('status');
    assert.doesNotMatch(app.messages.at(-1).content, /\nForged status/);
    assert.match(app.messages.at(-1).content, /research\\nForged status/);
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete');
    assert.match(JSON.stringify(app.calls[0].transcript), /retain-this-input/);
    assert.equal(app.calls.length, 1);
  } finally { await app.shutdown(); }
});

const hostTool = (execute, name = 'corpus_search') => ({
  name, label: 'Explicit corpus tool', description: 'Read the host-approved corpus only.',
  parameters: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string' } } },
  execute,
});
const corpusResult = text => ({ content: [{ type: 'text', text }], details: { text } });
const toolWorkflow = (name = 'corpus_search', args = { query: 'receipts' }) => ({
  v: 2, name: 'Explicit host corpus read', schemas: { ToolResult: { type: 'object', required: ['content', 'details'], properties: { content: { type: 'array' }, details: { type: 'object' } } } },
  output: { schemaId: 'ToolResult', path: 'result' },
  root: { node: 'call', label: 'read-corpus', via: 'tool', tool: name, args, out: 'ToolResult', as: 'result', deadline_s: 5 },
});
const judgeWorkflow = () => ({
  v: 2, name: 'Host judgment', schemas: { Decision: { type: 'object', required: ['supported'], properties: { supported: { type: 'boolean', description: 'Does the supplied evidence support the claim?' } } } },
  output: { schemaId: 'Decision', path: 'decision' },
  root: { node: 'judge', label: 'check-evidence', state: { evidence: '{evidence}' }, out: 'Decision', as: 'decision' },
});

test('interactive slash run yields so status and stop dispatch before a deferred tool finishes', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred(); let signal;
  const app = await harness({ hasUI: true, withModel: false, extensionOptions: {
    hostTools: () => [hostTool(async (_id, _args, selectedSignal) => { signal = selectedSignal; entered.resolve(); await release.promise; return corpusResult('Late result'); })],
  } });
  try {
    await app.tool({ action: 'inspect', workflow: toolWorkflow() });
    await app.command('run');
    await entered.promise;
    assert.equal(app.messages.filter(message => message.details?.status).length, 0);
    await app.command('status'); assert.equal(app.messages.at(-1).details.running, true);
    await app.command('stop'); assert.equal(signal.aborted, true);
    release.resolve();
    await waitUntil(() => app.messages.some(message => message.details?.status === 'interrupted'));
    assert.equal(app.messages.filter(message => message.details?.status).length, 1);
    assert.equal(app.messages.at(-1).details.output, undefined);
    await app.command('status'); assert.equal(app.messages.at(-1).details.running, false);
  } finally { release.resolve(); await app.shutdown(); }
});

for (const termination of ['stop', 'shutdown']) {
  test(`interactive live demo yields to ${termination} and retains child cancellation cleanup`, { timeout: 5000 }, async () => {
    const app = await harness({ hasUI: true, tokensPerSecond: 1,
      responses: [fauxAssistantMessage('This fictional planning response stays open until cancelled.')],
      extensionOptions: { createJudge: () => async () => { assert.fail('Cancelled planning must not reach Jev'); } },
    });
    try {
      await app.command('demo live');
      await app.entered.promise;
      assert.equal(app.messages.filter(message => message.details?.status).length, 0);
      await app.command('status');
      assert.equal(app.messages.at(-1).details.running, true);
      await app.command('demo');
      assert.match(app.messages.at(-1).content, /workflow is running/);
      assert.equal((await app.tool({ action: 'describe' })).details.mode, 'live', 'busy demo cannot replace the active mode');
      if (termination === 'stop') {
        await app.command('stop');
        await waitUntil(() => app.messages.some(message => message.details?.status === 'interrupted'));
        assert.equal(app.messages.filter(message => message.details?.status).length, 1);
      } else {
        await app.shutdown();
        assert.equal(app.messages.filter(message => message.details?.status).length, 0);
      }
      assert.equal(app.calls.length, 1);
      assert.equal(app.calls[0].options.signal.aborted, true);
      assert.equal(app.statuses.at(-1).value, undefined);
      assert.equal(app.widgets.at(-1).value, undefined);
    } finally { await app.shutdown(); }
  });
}

test('headless live demo awaits its terminal report', { timeout: 5000 }, async () => {
  const app = await harness({ hasUI: false, tokensPerSecond: 1,
    responses: [fauxAssistantMessage('This fictional planning response stays open until cancelled.')],
    extensionOptions: { createJudge: () => async () => { assert.fail('Cancelled planning must not reach Jev'); } },
  });
  let settled = false;
  try {
    const running = app.command('demo live').then(() => { settled = true; });
    await app.entered.promise;
    assert.equal(settled, false);
    assert.equal(app.messages.filter(message => message.details?.status).length, 0);
    await app.command('stop');
    await running;
    assert.equal(settled, true);
    assert.equal(app.messages.at(-1).details.status, 'interrupted');
    assert.equal(app.calls[0].options.signal.aborted, true);
  } finally { await app.shutdown(); }
});

test('headless slash run continues awaiting its report until a deferred tool finishes', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred(); let settled = false;
  const app = await harness({ hasUI: false, withModel: false, extensionOptions: {
    hostTools: () => [hostTool(async () => { entered.resolve(); await release.promise; return corpusResult('Complete'); })],
  } });
  try {
    await app.tool({ action: 'inspect', workflow: toolWorkflow() });
    const running = app.command('run').then(() => { settled = true; });
    await entered.promise; assert.equal(settled, false);
    release.resolve(); await running;
    assert.equal(settled, true); assert.equal(app.messages.at(-1).details.status, 'complete');
  } finally { release.resolve(); await app.shutdown(); }
});

test('interactive run keeps the launch model, thinking level and tool implementation after host selection changes', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred(); let implementation = async () => {
    entered.resolve(); await release.promise; return corpusResult('Launch tool');
  };
  const app = await harness({ hasUI: true, responses: [fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'Done' } }))],
    extensionOptions: { hostTools: () => [hostTool(implementation)] } });
  try {
    const definition = workflow({ node: 'chain', steps: [toolWorkflow().root,
      { node: 'agent', label: 'finish', instructions: 'Submit the fictional fixture result.', out: 'Result', as: 'answer' }] });
    definition.schemas.ToolResult = toolWorkflow().schemas.ToolResult;
    definition.output.path = 'answer';
    await app.tool({ action: 'inspect', workflow: definition });
    const selected = app.ctx.model;
    await app.command('run'); await entered.promise;
    app.ctx.model = undefined; app.ctx.thinkingLevel = 'high';
    implementation = async () => { throw new Error('Changed tool must not be selected mid-run'); };
    release.resolve();
    await waitUntil(() => app.messages.some(message => message.details?.status));
    assert.equal(app.messages.at(-1).details.status, 'complete');
    assert.equal(app.calls[0].model, selected); assert.equal(app.calls[0].options.reasoning, 'low');
  } finally { release.resolve(); await app.shutdown(); }
});

test('configured host tool inventory replaces built-ins and demo even during trusted execution', async () => {
  let executions = 0, attempts = 0;
  const app = await harness({ activeTools: ['read', 'bash', 'write'], withModel: false,
    extensionOptions: { hostTools: () => [hostTool(async () => { executions++; return corpusResult('Approved source'); })], onToolAttempt: () => { attempts++; } },
  });
  try {
    const described = await app.tool({ action: 'describe' });
    assert.deepEqual(described.details.tools.map(tool => tool.name), ['corpus_search']);
    assert.deepEqual(described.details.tools[0].resultSchema.required, ['content']);
    assert.match(described.details.tools[0].resultContract, /Do not invent fields/);
    assert.equal(attempts, 0, 'describe is an outer attempt owned by the calling host');
    await app.tool({ action: 'inspect', workflow: toolWorkflow() });
    await app.command('run --trusted');
    assert.equal(app.messages.at(-1).details.status, 'complete');
    assert.deepEqual(app.messages.at(-1).details.output, corpusResult('Approved source'));
    assert.equal(executions, 1); assert.equal(attempts, 1);
    await assert.rejects(app.tool({ action: 'inspect', workflow: toolWorkflow('read') }), /registered/);
    const retained = await app.tool({ action: 'inspect' });
    assert.equal(retained.details.inspection.sha256, (await app.tool({ action: 'inspect', workflow: toolWorkflow() })).details.inspection.sha256);
    assert.equal(executions, 1); assert.equal(attempts, 1);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('discovery exposes exact direct-call return contracts without executing tools', async () => {
  const app = await harness({ withModel: false });
  try {
    const described = await app.tool({ action: 'describe' });
    const lookup = described.details.tools.find(tool => tool.name === 'support_demo_lookup');
    assert.deepEqual(lookup.resultSchema.required, ['evidence']);
    assert.equal(lookup.resultSchema.additionalProperties, false);
    assert.equal(lookup.resultSchema.properties.matches, undefined);
    const handoff = described.details.tools.find(tool => tool.name === 'support_demo_handoff');
    assert.deepEqual(handoff.resultSchema, supportTriageWorkflow.schemas.Handoff);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
  let executed = false;
  const schema = { type: 'object', properties: { content: { type: 'array' }, details: { type: 'object', properties: { note: { type: 'string' } } } }, required: ['content', 'details'] };
  const configured = await harness({ withModel: false, extensionOptions: {
    hostTools: () => [{ ...hostTool(async () => { executed = true; return corpusResult('source'); }), resultSchema: schema }],
  } });
  try {
    const described = await configured.tool({ action: 'describe' });
    assert.deepEqual(described.details.tools[0].resultSchema, schema);
    assert.equal(executed, false);
  } finally { await configured.shutdown(); }
});

test('read-only inspect returns the exact draft and input to an author while rendering a human preview', async () => {
  const app = await harness({ withModel: false });
  try {
    await app.tool({ action: 'inspect', workflow: supportTriageWorkflow, input: supportTriageInputs.billing });
    const inspected = await app.tool({ action: 'inspect' });
    const model = JSON.parse(inspected.content[0].text);
    assert.deepEqual(model.workflow, supportTriageWorkflow);
    assert.deepEqual(model.input, supportTriageInputs.billing);
    const rendered = app.tools.get('agentrun').renderResult(inspected, { expanded: false }).render(100).join('\n');
    assert.match(rendered, /fictional-support-triage/);
    assert.doesNotMatch(rendered, /"additionalProperties"/);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('an unrestorable receipt is disclosed instead of silently added to native history', async () => {
  const app = await harness({ withModel: false });
  try {
    const inspected = await app.tool({ action: 'inspect', workflow: workflow(), input: { large: 'x'.repeat(8 * 1024 * 1024) } });
    assert.match(inspected.details.view.summary.join('\n'), /could not be retained/);
    assert.equal(app.branch.length, 0);
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('configured search keeps the ordinary tool envelope and refreshed same-name implementation', async () => {
  let version = 'inspected';
  const app = await harness({ withModel: false, extensionOptions: { hostTools: () => {
    const captured = version;
    return [hostTool(async () => corpusResult(captured), 'search')];
  } } });
  try {
    await app.tool({ action: 'inspect', workflow: toolWorkflow('search') });
    version = 'execution-context';
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete');
    assert.deepEqual(result.details.output, corpusResult('execution-context'));
  } finally { await app.shutdown(); }
});

test('native child tool attempts count unknown, invalid, valid and submit once each', async () => {
  let executions = 0, attempts = 0;
  const app = await harness({ extensionOptions: {
    hostTools: () => [hostTool(async () => { executions++; return corpusResult('Approved source'); })],
    onToolAttempt: () => { attempts++; },
  }, responses: [
    fauxAssistantMessage(fauxToolCall('unavailable_tool', {})),
    fauxAssistantMessage(fauxToolCall('corpus_search', {})),
    fauxAssistantMessage(fauxToolCall('corpus_search', { query: 'receipts' })),
    fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'Approved source' } })),
  ] });
  try {
    const definition = workflow(); definition.root.tools = ['corpus_search'];
    await app.tool({ action: 'inspect', workflow: definition });
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete');
    assert.equal(attempts, 4); assert.equal(executions, 1);
    assert.equal(app.calls.length, 4);
    const displayed = app.tools.get('agentrun').renderResult(result).render(160).join('\n');
    assert.match(displayed, /Workflow calls: 0 direct tool calls, 0 system one decisions, 1 model step/,
      'graph calls are distinguished from the four child tool attempts and model requests');
  } finally { await app.shutdown(); }
});

for (const mode of ['direct', 'native']) {
  test(`host tool admission rejection prevents ${mode} effects`, async () => {
    let executions = 0, attempts = 0;
    const app = await harness({ extensionOptions: {
      hostTools: () => [hostTool(async () => { executions++; return corpusResult('Must not run'); })],
      onToolAttempt: () => { attempts++; throw new Error('host_budget_exhausted'); },
    }, responses: [fauxAssistantMessage(fauxToolCall('corpus_search', { query: 'receipts' }))] });
    try {
      const definition = mode === 'direct' ? toolWorkflow() : workflow();
      if (mode === 'native') definition.root.tools = ['corpus_search'];
      await app.tool({ action: 'inspect', workflow: definition });
      const result = await app.tool({ action: 'run' });
      assert.equal(result.details.status, 'failed');
      assert.equal(executions, 0); assert.equal(attempts, 1);
    } finally { await app.shutdown(); }
  });
}

test('direct schema rejection is counted before execution and host definitions cannot smuggle reserved tools', async () => {
  let executions = 0, attempts = 0;
  const tool = hostTool(async () => { executions++; return corpusResult('Must not run'); });
  const app = await harness({ withModel: false, extensionOptions: { hostTools: () => [tool], onToolAttempt: () => { attempts++; } } });
  try {
    await app.tool({ action: 'inspect', workflow: toolWorkflow('corpus_search', { query: 123 }) });
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'failed'); assert.equal(executions, 0); assert.equal(attempts, 1);
  } finally { await app.shutdown(); }
  for (const tools of [[{ ...tool, name: 'submit' }], [{ ...tool, name: 'agentrun' }], [tool, tool]]) {
    const invalid = await harness({ extensionOptions: { hostTools: () => tools } });
    try { await assert.rejects(invalid.tool({ action: 'describe' }), /reserved or duplicate/); }
    finally { await invalid.shutdown(); }
  }
});

test('host judge is lazy, receives cancellation, and needs no ambient provider configuration', async () => {
  let factories = 0, receivedSignal, receivedRequest;
  const app = await harness({ withModel: false, extensionOptions: { hostTools: () => [], createJudge: ({ signal }) => {
    factories++; receivedSignal = signal;
    return async request => { receivedRequest = request; return { answers: { supported: { type: 'noul', noul: 1 } } }; };
  } } });
  try {
    const description = await app.tool({ action: 'describe' });
    assert.equal(description.details.jev, true); assert.equal(factories, 0);
    await app.tool({ action: 'inspect', workflow: judgeWorkflow(), input: { evidence: 'A source passage.' } });
    assert.equal(factories, 0);
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete');
    assert.deepEqual(result.details.output, { supported: true });
    assert.equal(factories, 1); assert.equal(receivedSignal.aborted, false);
    assert.deepEqual(receivedRequest.state, { evidence: 'A source passage.' });
    assert.equal(app.calls.length, 0);
  } finally { await app.shutdown(); }
});

test('host judge configuration failure does not select an ambient fallback', async () => {
  const app = await harness({ extensionOptions: { createJudge: () => { throw new Error('host_judge_unavailable'); } } });
  try {
    await app.tool({ action: 'inspect', workflow: judgeWorkflow(), input: { evidence: 'Valid input before adapter admission.' } });
    await assert.rejects(app.tool({ action: 'run' }), /host_judge_unavailable/);
    assert.equal(app.calls.length, 0);
    await app.command('history');
    assert.match(app.messages.at(-1).content, /No retained runs/);
  } finally { await app.shutdown(); }
});

test('only explicit host null limits allow native execution beyond default model, tool, turn and submission ceilings', async () => {
  const runtimeLimits = { deadlineMs: null, modelRequests: null, judgeCalls: null, toolAttempts: null,
    nodeMaxTurns: null, nodeMaxSubmissions: null, nodeTimeoutMs: null };
  let attempts = 0;
  const app = await harness({ extensionOptions: { runtimeLimits,
    hostTools: () => [hostTool(async () => corpusResult('Approved source'))], onToolAttempt: () => { attempts++; },
  }, responses: [
    ...Array.from({ length: 101 }, () => fauxAssistantMessage(fauxToolCall('corpus_search', { query: 'receipts' }))),
    ...Array.from({ length: 6 }, () => fauxAssistantMessage(fauxToolCall('submit', { value: {} }))),
    fauxAssistantMessage(fauxToolCall('submit', { value: { content: 'Complete after all attempts' } })),
  ] });
  try {
    assert.deepEqual((await app.tool({ action: 'describe' })).details.limits, runtimeLimits);
    const definition = workflow(); definition.root.tools = ['corpus_search'];
    await app.tool({ action: 'inspect', workflow: definition });
    const result = await app.tool({ action: 'run' });
    assert.equal(result.details.status, 'complete');
    assert.equal(attempts, 108); assert.equal(app.calls.length, 108);
  } finally { await app.shutdown(); }
  for (const value of [Infinity, -1, 0, 'unlimited']) assert.throws(() => createAgentRunExtension({ runtimeLimits: { modelRequests: value } }), /runtimeLimits/);
});
