import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectWorkflow } from '@parcha/agentrun-dsl';
import { workflowView } from '../dist/workflow-view.js';

const cli = fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const extension = fileURLToPath(new URL('../dist/extension.js', import.meta.url));
const workflow = {
  v: 2, name: 'fictional-delayed-local-call',
  schemas: { Result: { type: 'object', required: ['content'], properties: { content: { type: 'array', items: { type: 'object' } } } } },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'call', label: 'fictional-delayed-call', via: 'tool', tool: 'fictional_delayed', args: {}, out: 'Result', as: 'result', deadline_s: 60 },
};

async function host(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-native-closure-'));
  const session = join(directory, 'established.jsonl');
  const wrapper = join(directory, 'fixture-extension.mjs');
  await mkdir(join(directory, 'agent'));
  // Supported native initialization of an established persistent session, with
  // no synthetic assistant response and no provider or model invocation.
  await writeFile(session, '');
  await writeFile(wrapper, `import { createAgentRunExtension } from ${JSON.stringify(extension)};
const workflow = ${JSON.stringify(workflow)};
export default function(pi) {
  let agentrun;
  createAgentRunExtension({ hostTools: () => [{ name: 'fictional_delayed', label: 'Fictional delayed local fixture',
    description: 'No external effect. Deliberately remains unsettled on cancellation to exercise uncertainty accounting.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _args, signal) {
      pi.sendMessage({ customType: 'fixture:admitted', content: 'Fictional local tool admitted', display: true });
      await new Promise(() => {});
      throw new Error('Fixture must never complete successfully');
    },
  }] })({ ...pi, registerTool(definition) { if (definition.name === 'agentrun') agentrun = definition; pi.registerTool(definition); } });
  pi.registerCommand('fixture-prepare', { description: 'Stage a fictional fixture without inference', async handler(args, ctx) {
    const candidate = structuredClone(workflow);
    if (args === 'agent') candidate.root = { node: 'agent', label: 'fictional-needs-model', instructions: 'Do not run: missing model admission fixture.', tools: [], out: 'Result', as: 'result' };
    await agentrun.execute('fixture-inspection', { action: 'inspect', workflow: candidate, input: {} }, new AbortController().signal, undefined, ctx);
    pi.sendMessage({ customType: 'fixture:prepared', content: 'Fixture staged without execution', display: true });
  } });
}
`);
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills',
    '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-tools', '-e', wrapper, '--session', session], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, 'agent'), PI_OFFLINE: '1', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(), events = [];
  let sequence = 0, closed = false, stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { stderr += `\n${line}`; return; }
    events.push(event);
    const waiter = event.type === 'response' && pending.get(event.id);
    if (waiter) { pending.delete(event.id); clearTimeout(waiter.timer); waiter.resolve(event); }
  });
  const exited = once(child, 'close').then(([code, signal]) => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Pi exited ${code ?? signal}: ${stderr}`)); }
    pending.clear(); return { code, signal };
  });
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    await exited; lines.close(); await rm(directory, { recursive: true, force: true });
  });
  async function request(type, fields = {}) {
    assert.equal(closed, false, stderr);
    const id = `closure-${++sequence}`;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi ${type} watchdog: ${stderr}`)), 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
    assert.equal(result.success, true, JSON.stringify(result)); return result.data;
  }
  const messages = async () => (await request('get_messages')).messages;
  async function waitMessage(predicate) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const found = (await messages()).find(predicate);
      if (found) return found;
      await nextTurn();
    }
    assert.fail(`Expected native message missing: ${stderr}; messages=${JSON.stringify(await messages())}`);
  }
  async function stop() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    try { assert.deepEqual(await exited, { code: 0, signal: null }, stderr); }
    finally { clearTimeout(timer); }
  }
  const snapshots = async () => (await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(entry => entry.type === 'custom' && entry.customType === 'agentrun:snapshot');
  return { request, messages, waitMessage, stop, snapshots, events };
}

for (const closing of ['switch', 'shutdown']) {
  test(`native Pi ${closing} retains cancellation counts and unknown effects on the originating session only`, { timeout: 45_000 }, async t => {
    const app = await host(t);
    await app.request('prompt', { message: '/fixture-prepare' });
    await app.waitMessage(message => message.customType === 'fixture:prepared');
    await app.request('prompt', { message: '/agentrun run' });
    await app.waitMessage(message => message.customType === 'fixture:admitted');
    const start = (await app.snapshots()).at(-1).data;
    assert.equal(start.running, true);
    assert.equal(start.report, undefined);
    if (closing === 'switch') {
      assert.equal((await app.request('new_session')).cancelled, false);
      assert.deepEqual(await app.messages(), [], 'the destination session receives no old output or run receipt');
    } else await app.stop();
    const receipts = await app.snapshots();
    const ended = receipts.at(-1).data;
    assert.equal(ended.running, false);
    assert.equal(ended.runId, start.runId);
    assert.equal(ended.report.digest, inspectWorkflow(workflow).sha256);
    assert.equal(ended.report.status, 'interrupted');
    assert.deepEqual(ended.report.calls, { agent: 0, judge: 0, tool: 1 });
    assert.equal(ended.report.output, undefined);
    assert.equal(ended.report.uncertainEffects.length, 1);
    assert.equal(ended.report.uncertainEffects[0].outcome, 'unknown');
    assert.equal(ended.report.uncertainEffects[0].executionPath, '/root');
    assert.ok(ended.observation.steps['/root']);
    const view = workflowView(ended.workflow, { observation: ended.observation, report: ended.report });
    assert.equal(view.nodes.find(node => node.path === '/root').status, 'interrupted', 'terminal presentation cannot claim this step is still running');
    assert.equal(app.events.some(event => event.type === 'agent_start'), false);
    if (closing === 'switch') {
      await app.request('prompt', { message: '/agentrun history' });
      const history = await app.waitMessage(message => message.customType === 'agentrun');
      assert.match(history.content, /No retained runs/);
      await app.stop();
      assert.equal((await app.snapshots()).length, receipts.length, 'closing the new session cannot append to the old branch');
    }
  });
}

test('native Pi model setup rejection creates no misleading run-start receipt', { timeout: 45_000 }, async t => {
  const app = await host(t);
  await app.request('prompt', { message: '/fixture-prepare agent' });
  await app.waitMessage(message => message.customType === 'fixture:prepared');
  const before = await app.snapshots();
  await app.request('prompt', { message: '/agentrun run' });
  const failure = await app.waitMessage(message => message.customType === 'agentrun');
  assert.match(failure.content, /requires an active Pi model/);
  await app.stop();
  assert.deepEqual(await app.snapshots(), before);
  assert.ok(before.every(entry => !entry.data.running && !entry.data.runId && !entry.data.report));
  assert.equal(app.events.some(event => event.type === 'agent_start'), false);
});
