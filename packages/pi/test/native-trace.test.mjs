import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRunExtension } from '../dist/extension.js';
import { loadAuthorReference } from '@parcha/agentrun-dsl';

// Fictional registered-extension integration; no provider, source corpus or network.
function app(options = {}, hasUI = false) {
  const tools = new Map(), commands = new Map(), handlers = new Map(), messages = [], statuses = [];
  const ctx = { cwd: process.cwd(), hasUI, model: undefined, modelRegistry: { getAll: () => [] },
    sessionManager: { getSessionId: () => 'fictional-trace' },
    ui: { setStatus: (...args) => statuses.push(args), setWidget: () => {} } };
  createAgentRunExtension({ hostTools: () => [], ...options })({
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, handler), getActiveTools: () => [], getAllTools: () => [],
    getCommands: () => [], getThinkingLevel: () => 'high', sendMessage: message => messages.push(message),
  });
  return { ctx, messages, statuses,
    tool: args => tools.get('agentrun').execute('fictional', args, undefined, undefined, ctx),
    command: args => commands.get('agentrun').handler(args, ctx),
    close: () => handlers.get('session_shutdown')(),
  };
}
const schema = { type: 'object', required: ['value'], additionalProperties: false, properties: { value: { type: 'number' } } };
const graph = root => ({ v: 2, name: 'fictional trace stream', schemas: { Result: schema },
  output: { schemaId: 'Result', path: 'result' }, root });
const finish = { node: 'code', label: 'finish', code: 's => ({ result: { value: 7 } })' };

test('native host receives full >1MiB sanitized trace while report retention stays bounded', async () => {
  const frames = [], h = app({ onWorkflowEvent: frame => frames.push(frame) });
  try {
    const workflow = graph({ node: 'chain', steps: [
      ...Array.from({ length: 12 }, (_, i) => ({ node: 'code', label: `fictional-patch-${i}`,
        code: 's => ({ payload: "x".repeat(110000), secret: "private-sentinel", nested: { authorization: "private-sentinel", visible: true } })' })), finish,
    ] });
    const inspected = await h.tool({ action: 'inspect', workflow });
    assert.equal(frames.length, 0, 'inspection is nonexecuting');
    await h.command('run --trusted');
    const report = h.messages.at(-1).details;
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.output, { value: 7 });
    assert.equal(report.traceTruncated, true);
    assert(Buffer.byteLength(JSON.stringify(frames)) > 1024 * 1024);
    assert(report.events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0) <= 1024 * 1024);
    assert.equal(frames.filter(frame => frame.event.type === 'code.patch').length, 13);
    assert.deepEqual(frames.map(frame => frame.sequence), frames.map((_, i) => i + 1));
    assert(frames.every(frame => frame.workflowDigest === inspected.details.inspection.sha256 && frame.runOrdinal === 1));
    assert.doesNotMatch(JSON.stringify(frames), /private-sentinel|authorization/);
    const count = frames.length;
    await assert.rejects(h.tool({ action: 'run' }), /Code|Executable|code|trusted/);
    assert.equal(frames.length, count, 'prior trust does not carry to another run');
    await h.tool({ action: 'inspect', workflow: graph(finish) });
    await h.command('run --trusted');
    assert.equal(frames[count].runOrdinal, 2);
    assert.equal(frames[count].sequence, 1);
  } finally { await h.close(); }
});

test('native observer mutation and synchronous/asynchronous errors cannot change output or UI', async () => {
  for (const rejectAsync of [false, true]) {
    const frames = [], h = app({ onWorkflowEvent: frame => {
      frames.push(structuredClone(frame));
      if (frame.event.type === 'code.patch') frame.event.detail.result.value = 99;
      if (rejectAsync) return Promise.reject(new Error('fictional-observer-private'));
      throw new Error('fictional-observer-private');
    } }, true);
    try {
      await h.tool({ action: 'inspect', workflow: graph(finish) });
      await h.command('run --trusted');
      // UI slash runs return at launch; wait for their terminal message.
      while (!h.messages.some(message => message.details?.status)) await new Promise(resolve => setImmediate(resolve));
      const report = h.messages.find(message => message.details?.status).details;
      assert.equal(report.status, 'complete');
      assert.deepEqual(report.output, { value: 7 });
      assert.equal(report.events.find(event => event.type === 'code.patch').detail.result.value, 7);
      assert(frames.length >= 3);
      assert(h.statuses.length > 0);
      assert.doesNotMatch(JSON.stringify(report), /fictional-observer-private/);
    } finally { await h.close(); }
  }
});

test('native full-stream observer delivers a valid event above the old 512KiB clone limit', async () => {
  const frames = [], h = app({ onWorkflowEvent: frame => frames.push(frame) });
  try {
    await h.tool({ action: 'inspect', workflow: graph({ node: 'chain', steps: [
      { node: 'code', label: 'large-fictional-patch', code: 's => ({ payload: "x".repeat(600000) })' }, finish,
    ] }) });
    await h.command('run --trusted');
    assert.equal(h.messages.at(-1).details.status, 'complete');
    assert.equal(frames.find(frame => frame.event.type === 'code.patch' && frame.event.label === 'large-fictional-patch').event.detail.payload.length, 600000);
  } finally { await h.close(); }
});

test('native cancellation cleanup reaches the host stream and stops at run closure', async () => {
  let entered, toolSignal;
  const waiting = new Promise(resolve => { entered = resolve; });
  const frames = [], h = app({ onWorkflowEvent: frame => frames.push(frame), hostTools: () => [{
    name: 'fictional_wait', description: 'Fictional abortable tool.', parameters: { type: 'object', properties: {} },
    execute: (_id, _args, signal) => new Promise((_resolve, reject) => {
      toolSignal = signal; entered();
      signal.addEventListener('abort', () => reject(new Error('fictional-tool-private')), { once: true });
    }),
  }] });
  try {
    await h.tool({ action: 'inspect', workflow: graph({ node: 'call', label: 'fictional-wait', via: 'tool',
      tool: 'fictional_wait', args: {}, out: 'Result', as: 'result', deadline_s: 60 }) });
    const run = h.command('run');
    await waiting;
    await h.command('stop');
    await run;
    assert.equal(toolSignal.aborted, true);
    assert.equal(h.messages.at(-1).details.status, 'interrupted');
    assert(frames.some(frame => frame.event.type === 'node.end' && frame.event.detail.status === 'failed'));
    assert.doesNotMatch(JSON.stringify(frames), /fictional-tool-private/);
    const count = frames.length;
    await h.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, count);
  } finally { await h.close(); }
});

test('trace callback configuration is host-owned and validated before registration', () => {
  for (const value of [true, {}, 'callback']) assert.throws(() => createAgentRunExtension({ onWorkflowEvent: value }), /host callback/);
});

test('native describe delivers the complete shipped workflow contract to tool-only hosts', async () => {
  const h = app();
  try {
    const result = await h.tool({ action: 'describe' });
    assert.equal(result.details.authoring.workflow, loadAuthorReference('workflow-format'));
    assert(result.details.authoring.workflow.length > 1000);
    assert.doesNotMatch(result.details.authoring.workflow, /\/(?:home|Users)\/|127\.0\.0\.1|\.cascade\//);
    assert.equal(result.details.authoring.onWorkflowEvent, undefined);
  } finally { await h.close(); }
});
