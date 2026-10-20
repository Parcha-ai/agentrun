// agentApp: the run app for one agent with no workflow, here mostly on the host the environment gives (hostFromEnv). It installs and offers exactly the tools the agent names, refuses a name
// it cannot offer when it is called, and runs under `pi-durable-disk run --app`: a command the agent runs acts in the run's work directory and sees none of the host's keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { localRun, openDurableRun } from '@parcha/pi-durable-disk';
import { agentApp, agentTools, hostFromEnv, localHost, placeAt } from '@parcha/agentrun-harness';
import { fakes } from './reference/job.ts';

const CLI = fileURLToPath(new URL('../packages/pi-durable-disk/dist/cli.js', import.meta.url));
const APP = fileURLToPath(new URL('./reference/agent-app-fixture.ts', import.meta.url));
const NO_BROWSER = 'set CHROME_PATH or both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID';

async function scratch(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'agent-app-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  return tmp;
}

async function envHost(t, env = {}) {
  const place = await placeAt(join(await scratch(t), 'run'), 'agent');
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { place, host: await hostFromEnv(place, { models, lead: { provider: faux.provider.id, modelId: faux.getModel().id }, env }) };
}

const offered = (app) => app.root.agent.tools.map((tool) => tool.name);
const installed = (app) => app.registry.snapshot().tools().map(({ tool }) => tool.name).sort();

test('agentApp offers exactly the tools the agent names, installs no other, and binds the lead at the node runner\'s thinking rule', async (t) => {
  const { nodeAgent } = await import('../packages/harness/dist/assemble.js');
  const { place, host } = await envHost(t);
  const app = await agentApp(place, host, { instructions: 'Answer.', tools: ['bash', 'read'] });
  assert.deepEqual(offered(app), ['bash', 'read'], 'in the order the agent names them');
  assert.deepEqual(installed(app), ['bash', 'read'], 'write and edit are not installed');
  assert.equal(app.models, host.models.catalog);
  assert.deepEqual(app.root.agent.model, host.models.lead);
  assert.equal(app.root.agent.instructions, 'Answer.');
  assert.equal(app.root.agent.thinkingLevel, nodeAgent(host.models.lead, {}).thinkingLevel, 'no thinking named: the node runner\'s default');
  assert.equal((await agentApp(place, host, { instructions: '', tools: [], thinking: 'off' })).root.agent.thinkingLevel, nodeAgent(host.models.lead, {}).thinkingLevel, 'thinking is never off');
  assert.equal((await agentApp(place, host, { instructions: '', tools: [], thinking: 'high' })).root.agent.thinkingLevel, 'high');
  assert.equal(app.onOpen, undefined, 'no workflow to drive');
  assert.equal(app.beforeResume, undefined, 'no browser and no recorder: nothing to do before the resume');
  assert.equal(app.wake, undefined, 'no browser sessions to release');
  const code = await agentApp(place, host, { instructions: '', tools: ['code'] });
  assert.deepEqual([offered(code), installed(code)], [['code'], ['code']], 'code mode alone: no coding tool comes with it');
  assert.deepEqual(installed(await agentApp(place, host, { instructions: '', tools: [] })), [], 'an agent that names no tool has none');
});

test('an unknown name, a browser tool on a host with no browser, and a browser tool on a run with none are refused when agentApp is called, with the tool and what it needs', async (t) => {
  const { place, host } = await envHost(t);
  await assert.rejects(agentApp(place, host, { instructions: '', tools: ['read', 'teleport'] }), (error) => error.message.startsWith('the definition names the tool teleport, which this host does not offer'));
  await assert.rejects(agentApp(place, host, { instructions: '', tools: ['read', 'browser_read'] }), { message: `the definition names the tool browser_read, and this host has no browser: ${NO_BROWSER}` });
  await assert.rejects(agentApp(place, host, { instructions: '', tools: ['read'], thinking: 'deep' }), /thinking/);
  const half = await envHost(t, { BROWSERBASE_API_KEY: 'bb-key' });
  await assert.rejects(agentApp(half.place, half.host, { instructions: '', tools: ['snapshot'] }), { message: `the definition names the tool snapshot, and this host has no browser: ${NO_BROWSER}` });
  const vocabulary = await agentTools(place, host);
  const entry = (name) => vocabulary.find((tool) => tool.name === name);
  assert.deepEqual(['read', 'write', 'edit', 'bash'].map((name) => entry(name)), ['read', 'write', 'edit', 'bash'].map((name) => ({ name, plane: 'coding', needs: null })));
  assert.deepEqual(entry('code'), { name: 'code', plane: 'code', needs: null });
  assert.deepEqual(entry('browser_read'), { name: 'browser_read', plane: 'browser', needs: 'browser', unmet: `this host has no browser: ${NO_BROWSER}` });
  assert.equal(vocabulary.filter((tool) => tool.plane === 'browser').length >= 5, true, 'every browser tool by its registered name');
  // The fake browser is a browser: its tools are offered, and only the ones named are installed.
  const local = localHost(place, fakes);
  const browsing = await agentApp(place, local.host, { instructions: '', tools: ['read', 'browser_read'] });
  assert.deepEqual([offered(browsing), installed(browsing)], [['read', 'browser_read'], ['browser_read', 'read']]);
  assert.equal(typeof browsing.beforeResume, 'function', 'the browser is reconciled before the run resumes');
  assert.equal(typeof browsing.wake, 'function', 'the browser\'s sessions are released before the run lets go');
  assert.equal(typeof browsing.root.init, 'function', 'the browser\'s configuration is in the commit that creates the conversation');
  await assert.rejects(agentApp(place, local.host, { instructions: '', tools: ['browser_read'] }, { browser: false }), { message: 'the definition names the tool browser_read, and this run has no browser (its options say browser: false)' });
  assert.equal((await agentTools(place, local.host)).find((tool) => tool.name === 'browser_read').unmet, undefined);
});

test('a browser tool in an agent run: its configuration is in the conversation\'s first commit, it is reconciled before the resume, and its sessions are released before the run lets go', { timeout: 120_000 }, async (t) => {
  const place = await placeAt(join(await scratch(t), 'run'), 'agent');
  const text = (message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  const lead = (messages) => {
    const result = messages.filter((message) => message.role === 'toolResult').at(-1);
    return result ? fauxAssistantMessage(`done: ${text(result)}`) : fauxAssistantMessage([fauxToolCall('browser_read', { what: 'markdown' })], { stopReason: 'toolUse' });
  };
  const local = localHost(place, { ...fakes, model: lead, tokensPerSecond: 0 });
  const app = await agentApp(place, local.host, { instructions: 'Read the page you are on.', tools: ['browser_read'] });
  const durable = await openDurableRun({ disk: 'local', region: 'local', id: place.id }, { ...localRun(place.root), harness: { registry: app.registry, models: app.models }, beforeResume: app.beforeResume });
  // Released before the scratch directory goes: a run whose directory is removed under it is fenced, and its process exits.
  try {
    const events = () => readFileSync(join(place.root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.source === 'browser');
    assert.equal(events().filter((event) => 'reconciled' in event).length, 1, 'reconciled once, before the resume');
    const conversation = await durable.harness.root(ctx, app.root);
    const submission = await conversation.submit({ type: 'input', requestId: 'first', content: 'Go.' }, ctx);
    assert.equal((await submission.wait(ctx)).status, 'done');
    assert.equal(local.evidence().filter((path) => path.includes('browser_read')).length, 1, 'the page read is filed');
    assert.ok(local.evidence().every((path) => path.startsWith('evidence/run/')), `the conversation's label names its evidence: ${local.evidence()}`);
    assert.deepEqual(events().filter((event) => 'change' in event).map((event) => event.change), ['launched']);
    await app.wake(durable, null);
    assert.deepEqual(events().filter((event) => 'change' in event).map((event) => event.change), ['launched', 'released'], 'the wake released the session');
    assert.equal(JSON.parse(readFileSync(join(place.root, 'run.json'), 'utf8')).status, 'sleeping');
  } finally { await durable.release(); }
});

/** The run under `pi-durable-disk run --app` with the fixture app, served on loopback; resolves once it has exited. */
async function agentRun(t, env) {
  const tmp = await scratch(t);
  const dir = join(tmp, 'run');
  const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'run', '--dir', dir, '--app', APP, '--id', 'agent', '--serve', '0', '--serve-host', '127.0.0.1'], {
    env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => proc.on('close', (code, signal) => resolve({ code, signal })));
  const door = async () => {
    for (const until = Date.now() + 60_000; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) {
      if (proc.exitCode !== null) break;
      try {
        const record = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
        if (record.status === 'running' && typeof record.holder?.serve === 'string') return record.holder.serve;
      } catch { /* not written yet */ }
    }
    throw new Error(`the run served no door: ${stderr.slice(-800)}`);
  };
  let answer;
  try {
    const serve = await door();
    // run.json can say running a moment before the door attaches the run, which it answers 503 until then; pi deduplicates the request id, so a retry is the same submission.
    for (const until = Date.now() + 30_000; ; await new Promise((resolve) => setTimeout(resolve, 100))) {
      const response = await fetch(new URL('/submit', serve), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'first', content: 'Go.', wait: true }) });
      answer = await response.json();
      if (response.status !== 503 || Date.now() > until) break;
    }
  } finally { proc.kill('SIGTERM'); }
  const exit = await exited;
  return { dir, answer, exit, stderr };
}

test('an agent run end to end under pi-durable-disk run --app: the lead\'s bash writes into the run\'s work directory, the run answers, and the command\'s environment holds no host key', { timeout: 120_000 }, async (t) => {
  const canary = `canary-${randomUUID()}`;
  const run = await agentRun(t, {
    TYPESAFE_API_KEY: canary, BROWSERBASE_API_KEY: canary, BROWSERBASE_PROJECT_ID: `${canary}-project`, AGENT_SECRET: canary,
    AGENT_TOOLS: JSON.stringify(['bash']), AGENT_CALL: JSON.stringify({ name: 'bash', arguments: { command: 'echo hi > hi.txt && printenv > env.txt' } }),
  });
  assert.equal(run.answer.submission?.status, 'done', JSON.stringify(run.answer) + run.stderr.slice(-800));
  assert.match(run.answer.answer.text, /^done: /);
  assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr.slice(-800));
  assert.equal(await readFile(join(run.dir, 'work', 'hi.txt'), 'utf8'), 'hi\n');
  const env = await readFile(join(run.dir, 'work', 'env.txt'), 'utf8');
  assert.ok(!env.includes(canary), 'no host key reaches the command');
  const names = new Set(env.split('\n').map((line) => line.split('=')[0]).filter(Boolean));
  for (const name of ['TYPESAFE_API_KEY', 'BROWSERBASE_API_KEY', 'AGENT_SECRET', 'AGENT_CALL']) assert.ok(!names.has(name), `${name} is not in the command's environment`);
  for (const name of ['PATH', 'HOME', 'TMPDIR']) assert.ok(names.has(name), `${name} is in the command's environment`);
});

test('code mode in an agent run: the script\'s tools.bash runs in the work directory, and on a host with no judge vision.judge has no Jev port', { timeout: 120_000 }, async (t) => {
  const script = [
    'await tools.bash({ command: "echo hi > hi.txt" });',
    'let judged = "answered";',
    'try { await vision.judge({ questions: { same: { type: "noul", instructions: "Are a and b the same word?" } }, state: { a: "hi", b: "hi" } }); } catch (error) { judged = String(error.message); }',
    'return { judged };',
  ].join('\n');
  const run = await agentRun(t, { AGENT_TOOLS: JSON.stringify(['code']), AGENT_CALL: JSON.stringify({ name: 'code', arguments: { code: script } }) });
  assert.equal(run.answer.submission?.status, 'done', JSON.stringify(run.answer) + run.stderr.slice(-800));
  assert.deepEqual(run.exit, { code: 0, signal: null }, run.stderr.slice(-800));
  assert.equal(await readFile(join(run.dir, 'work', 'hi.txt'), 'utf8'), 'hi\n');
  const result = JSON.parse(run.answer.answer.text.slice('done: '.length));
  assert.equal(result.ok, true, run.answer.answer.text);
  assert.match(result.value.judged, /no Jev port/);
});
