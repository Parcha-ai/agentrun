import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectWorkflow } from '@parcha/agentrun-dsl';
import { supportTriageInputs, supportTriageWorkflow } from '../dist/triage-demo.js';

const extension = fileURLToPath(new URL('../dist/extension.js', import.meta.url));
const cli = fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const digest = inspectWorkflow(supportTriageWorkflow).sha256;

// Actual Pi host, fictional local fixtures only. Do not inherit credentials, user
// settings, installed extensions, or a contributor's project/session directory.
function startHost(t, directory, session) {
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline',
    '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes',
    '--no-tools', '-e', extension, '--session', session], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory,
      PI_CODING_AGENT_DIR: join(directory, 'agent'), PI_OFFLINE: '1', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0, stderr = '', closed = false;
  const pending = new Map(), events = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { stderr += `\nNon-JSON stdout: ${line}`; return; }
    events.push(event);
    if (event.type === 'response') {
      const waiter = pending.get(event.id);
      if (waiter) { pending.delete(event.id); clearTimeout(waiter.timer); waiter.resolve(event); }
    }
  });
  const exited = once(child, 'close').then(([code, signal]) => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Pi exited (${code ?? signal}): ${stderr}`)); }
    pending.clear();
    return { code, signal };
  });
  async function dispose() { if (!closed) child.kill('SIGKILL'); await exited; lines.close(); }
  t.after(dispose);
  async function request(type, fields = {}) {
    assert.equal(closed, false, `Pi already exited: ${stderr}`);
    const id = `journey-${++sequence}`;
    const response = await new Promise((resolve, reject) => {
      // Watchdog diagnoses a dead host; command completion is always a response
      // or a terminal native message, never elapsed time.
      const timer = setTimeout(() => reject(new Error(`Pi RPC ${type} stalled: ${stderr}`)), 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }
  async function messages() { return (await request('get_messages')).messages; }
  async function command(text, accept = () => true) {
    const before = (await messages()).length;
    await request('prompt', { message: `/agentrun ${text}` });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const added = (await messages()).slice(before).filter(message => message.role === 'custom' && message.customType === 'agentrun');
      const result = added.find(accept);
      if (result) return result;
      await nextTurn();
    }
    assert.fail(`No expected terminal message for /agentrun ${text}: ${stderr}`);
  }
  async function stop() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { assert.deepEqual(await exited, { code: 0, signal: null }, stderr); }
    finally { clearTimeout(timer); }
  }
  return { request, command, messages, stop, dispose, events };
}

async function entries(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
const snapshots = rows => rows.filter(row => row.type === 'custom' && row.customType === 'agentrun:snapshot');
const complete = message => message.details?.status === 'complete';

test('native Pi persisted-session offline journey saves, restores, reruns and loads without restoring authority', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-native-journey-'));
  const hosts = [];
  const session = join(directory, 'journey.jsonl');
  await mkdir(join(directory, 'agent'));
  // Pi 0.87 explicitly initializes an existing empty --session file and then
  // persists custom entries. A brand-new, nonexistent session is deferred until
  // its first assistant response; this fixture does not fabricate such a turn.
  await writeFile(session, '');
  try {
    const first = startHost(t, directory, session);
    hosts.push(first);
    const billed = await first.command('triage billing', complete);
    assert.equal(billed.details.mode, 'scripted');
    assert.equal(billed.details.digest, digest);
    assert.equal(billed.details.output.queue, 'billing');
    assert.equal(billed.details.output.draftOnly, true);
    const saved = await first.command('save fictional-triage');
    assert.equal(saved.details.digest, digest);
    assert.match(saved.content, /Input and execution permission are not saved/);
    const history = await first.command('history');
    assert.equal(history.details.runs.length, 1);
    assert.equal(history.details.runs[0].digest, digest);
    const originalRunId = history.details.runs[0].runId;
    await first.stop();

    const firstEntries = await entries(session);
    const receipt = snapshots(firstEntries).at(-1).data;
    assert.deepEqual(receipt.input, supportTriageInputs.billing);
    assert.deepEqual(receipt.report.output, billed.details.output);
    assert.equal(receipt.runId, originalRunId);
    assert.equal(receipt.report.digest, inspectWorkflow(receipt.workflow).sha256);
    const nativeReceiptCount = snapshots(firstEntries).length;

    const second = startHost(t, directory, session);
    hosts.push(second);
    const inspected = await second.command('history 1');
    assert.deepEqual(inspected.details.run, receipt, 'real host reopens the exact native session receipt');
    assert.equal(snapshots(await entries(session)).length, nativeReceiptCount, 'restoring does not execute or append a run');
    await second.command(`input ${JSON.stringify(supportTriageInputs.technical)}`);
    const technical = await second.command('run', complete);
    assert.equal(technical.details.mode, 'scripted', 'changing the input does not change the restored demo execution mode');
    assert.equal(technical.details.digest, digest);
    assert.equal(technical.details.output.queue, 'technical');
    assert.equal(technical.details.output.ticketId, 'fictional-technical');
    const updatedHistory = await second.command('history');
    assert.equal(updatedHistory.details.runs.length, 2);
    assert.notEqual(updatedHistory.details.runs[0].runId, originalRunId);
    assert.equal(updatedHistory.details.runs[1].runId, originalRunId);
    assert.equal((await second.messages()).some(message => message.role === 'assistant'), false);
    await second.stop();

    const freshSession = join(directory, 'fresh.jsonl');
    await writeFile(freshSession, '');
    const fresh = startHost(t, directory, freshSession);
    hosts.push(fresh);
    const library = await fresh.command('list');
    assert.equal(library.details.workflows.length, 1);
    assert.equal(library.details.workflows[0].digest, digest);
    const loaded = await fresh.command(`load fictional-triage ${digest}`);
    assert.match(loaded.content, /Loading never executes/);
    const setup = await fresh.command('status');
    assert.equal(setup.details.mode, 'live', 'loading a saved definition does not confer demo execution authority');
    assert.equal(setup.details.running, false);
    const emptyHistory = await fresh.command('history');
    assert.match(emptyHistory.content, /No retained runs/);
    const rejected = await fresh.command('run');
    assert.notEqual(rejected.details.status, 'complete');
    assert.match(rejected.content, /input|required|schema/i, 'missing input is explained before provider access');
    const unknown = await fresh.command('run --invented');
    assert.match(unknown.content, /Unknown AgentRun command/);
    assert.equal((await fresh.messages()).some(message => message.role === 'assistant'), false);
    await fresh.stop();

    const storedFiles = await readdir(join(directory, '.pi', 'agentrun', 'workflows', 'fictional-triage'));
    assert.deepEqual(storedFiles, [`${digest}.json`, 'latest']);
    assert.equal(await readFile(join(directory, '.pi', 'agentrun', 'workflows', 'fictional-triage', 'latest'), 'utf8'), `${digest}\n`);
    const stored = JSON.parse(await readFile(join(directory, '.pi', 'agentrun', 'workflows', 'fictional-triage', storedFiles[0]), 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'digest', 'name', 'version', 'workflow']);
    const freshRows = snapshots(await entries(freshSession));
    assert.deepEqual(freshRows[0].data.input, {});
    for (const row of freshRows) {
      assert.deepEqual(row.data.input, {});
      assert.equal(row.data.demo, undefined);
      assert.equal(row.data.runId, undefined, 'loading and rejecting incomplete input never start a run');
      assert.equal(row.data.report, undefined);
      assert.equal(row.data.running, false);
    }
    for (const row of [...snapshots(await entries(session)), ...freshRows]) {
      assert.equal(row.data.workflow && inspectWorkflow(row.data.workflow).sha256, digest);
      for (const key of ['trusted', 'authorization', 'allowExecutableCandidates', 'modelAuth']) assert.equal(Object.hasOwn(row.data, key), false);
    }
    for (const host of [first, second, fresh]) {
      assert.equal(host.events.some(event => ['agent_start', 'tool_execution_start'].includes(event.type)), false,
        'native extension commands never enter the Pi model/tool loop');
    }
  } finally {
    await Promise.all(hosts.map(host => host.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('native Pi brand-new offline session warns that history is volatile while procedure saving is durable', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentrun-native-fresh-'));
  const session = join(directory, 'never-persisted.jsonl');
  await mkdir(join(directory, 'agent'));
  const host = startHost(t, directory, session);
  try {
    const report = await host.command('triage billing', complete);
    assert.equal(report.details.mode, 'scripted');
    assert.match(report.content, /Run receipts are in memory only/);
    assert.match(report.content, /Pi has not yet persisted this session/);
    assert.match(report.content, /Named procedure saves are durable/);
    await host.command('save fictional-triage');
    assert.equal((await host.command('history')).details.runs.length, 1, 'history is still available in this process');
    assert.equal((await host.messages()).some(message => message.role === 'assistant'), false);
    await host.stop();
    await assert.rejects(readFile(session), { code: 'ENOENT' }, 'no hidden synthetic assistant or private Pi-file mutation');
    const stored = JSON.parse(await readFile(join(directory, '.pi', 'agentrun', 'workflows', 'fictional-triage', `${digest}.json`), 'utf8'));
    assert.equal(stored.digest, digest);
    assert.equal(inspectWorkflow(stored.workflow).sha256, digest);
    assert.equal(Object.hasOwn(stored, 'input'), false);
    assert.equal(Object.hasOwn(stored, 'report'), false);
  } finally {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
