import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './native-fixtures/setup.mjs';

const SECRET = ['synthetic', 'bridge', 'credential'].join('-');
const NUMERIC = '987654321012';
const SESSION = '11111111-1111-4111-8111-111111111111';
const ROWS = Array.from({ length: 240 }, (_, index) => ({ name: `row-${index}`, value: 'x'.repeat(48) }));
const INPUT = {
  rows: ROWS,
  nested: { credential: SECRET, encoded: Buffer.from(SECRET).toString('base64'), numeric: Number(NUMERIC), safe: 7 },
  [SECRET]: 'sensitive property name',
  collision: { [SECRET]: 1, [Buffer.from(SECRET).toString('base64')]: 2 },
};
const OUTPUT = { rows: ROWS, credential: SECRET, atom: 'z'.repeat(9000), completed: true };

function bridge(t, f, extra = []) {
  const child = spawn(process.execPath, [...extra, fileURLToPath(new URL('../dist/native/remote-worker-bridge.js', import.meta.url))], {
    env: {
      PATH: f.env.PATH, HOME: f.home, CODEX_HOME: f.env.CODEX_HOME, CLAUDE_CONFIG_DIR: f.env.CLAUDE_CONFIG_DIR,
      NATIVE_TEST_LOG: f.env.NATIVE_TEST_LOG, SOURCE_TEST_TOKEN: SECRET, SOURCE_NUMERIC_TOKEN: NUMERIC,
    }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map(), messages = [], raw = [];
  let next = 0, diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const fail = error => { for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(error); } waiting.clear(); };
  createInterface({ input: child.stdout }).on('line', line => {
    raw.push(line);
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Bridge emitted a non-JSON protocol line')); child.kill('SIGTERM'); return; }
    messages.push(message);
    const entry = waiting.get(message.id);
    if (entry) {
      waiting.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error)) : entry.resolve(message);
    }
  });
  child.on('exit', code => fail(new Error(`Bridge exited ${code}`)));
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode !== null) return;
    await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGTERM'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  });
  return {
    messages, raw, diagnostics: () => diagnostics,
    call: (type, body = {}) => new Promise((resolve, reject) => {
      const id = body.id ?? `request-${++next}`;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Bridge ${type} timed out`)); }, 10_000);
      waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ ...body, id, type }) + '\n');
    }),
  };
}

async function nativeOutput(t, runtime) {
  const f = await nativeFixture(t), cli = join(f.root, 'output-cli.mjs');
  const protocol = runtime === 'claude-code' ? [
    { type: 'system', subtype: 'init', session_id: SESSION, model: 'fixture-model' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: INPUT }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: OUTPUT }] } },
    { type: 'result', subtype: 'success', session_id: SESSION, result: 'z'.repeat(9000), usage: { input_tokens: 8, output_tokens: 3 }, total_cost_usd: 0 },
  ] : [
    { type: 'thread.started', thread_id: SESSION },
    { type: 'item.started', item: { id: 'tool-1', type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', arguments: INPUT } },
    { type: 'item.completed', item: { id: 'tool-1', type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', arguments: INPUT, result: OUTPUT, status: 'completed' } },
    { type: 'item.completed', item: { id: 'answer-1', type: 'agent_message', text: 'z'.repeat(9000) } },
    { type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 3, cached_input_tokens: 0 } },
  ];
  await f.put(cli, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log(${JSON.stringify(runtime === 'claude-code' ? '2.1.322' : '0.167.2')});
else if (args.includes('status')) console.log(JSON.stringify({ loggedIn: true }));
else { readFileSync(0); process.stdout.write(${JSON.stringify(protocol.map(event => JSON.stringify(event)).join('\n') + '\n')}); }
`);
  await chmod(cli, 0o755);
  for (const name of ['claude', 'codex']) { const path = join(f.root, 'bin', name); await unlink(path); await symlink(cli, path); }
  return f;
}

for (const runtime of ['claude-code', 'codex']) {
  test(`remote ${runtime} keeps long minified payloads valid JSON and correlated while redacting credentials`, async t => {
    assert.ok(JSON.stringify(INPUT).length > 8192);
    const f = await nativeOutput(t, runtime), remote = bridge(t, f);
    const target = (await remote.call('discover', { payload: { project: f.project, runtime } })).result.targets[0];
    const prepared = await remote.call('prepare', { target });
    await remote.call('open', { target, session_key: 'source-session-key', payload: { expected_fingerprint: prepared.result.target.fingerprint } });
    const answer = await remote.call('send', { id: 'source-operation-id', target, session_key: 'source-session-key', payload: { prompt: 'Synthetic task', timeout_ms: 3000 } });
    assert.equal(answer.id, 'source-operation-id');
    assert.equal(answer.result.sessionId, SESSION);
    assert.equal(answer.result.answer, '[redacted]', 'the existing long-atom policy must remain in force for payload text');
    assert.equal(answer.result.usage.input_tokens, 8);
    const events = remote.messages.filter(message => message.event);
    assert.ok(events.length > 0);
    assert.ok(events.every(message => message.session_key === 'source-session-key'));
    const started = events.find(message => message.event.type === 'tool' && message.event.status === 'started').event;
    assert.equal(started.id, 'tool-1');
    assert.deepEqual(started.input.rows, ROWS);
    assert.deepEqual(started.input.nested, { credential: '[redacted]', encoded: '[redacted]', numeric: '[redacted]', safe: 7 });
    assert.equal(started.input['[redacted]'], 'sensitive property name');
    assert.equal(started.input.collision, '[redacted]', 'redacted names must never silently overwrite another field');
    const completed = events.find(message => message.event.type === 'tool' && message.event.status === 'completed').event;
    assert.deepEqual(completed.output, { rows: ROWS, credential: '[redacted]', atom: '[redacted]', completed: true });
    await remote.call('close', { target, session_key: 'source-session-key' });
    const exported = remote.raw.join('\n') + remote.diagnostics();
    for (const value of [SECRET, NUMERIC, Buffer.from(SECRET).toString('base64')]) assert.ok(!exported.includes(value), 'no credential form may reach stdout or stderr');
  });
}

test('remote payload redaction never invokes getters or toJSON and bounds non-JSON values', async t => {
  const f = await nativeFixture(t), preload = join(f.root, 'payload-boundary.mjs');
  const source = `export async function openNativeSession({onEvent}) {
  const forbidden = () => { process.stderr.write('unsafe-payload-executed'); throw new Error('Payload code must not execute'); };
  const evidence = {safe:'kept',secret:process.env.SOURCE_TEST_TOKEN};
  Object.defineProperty(evidence,'accessor',{enumerable:true,get:forbidden});
  Object.defineProperty(evidence,'toJSON',{get:forbidden});
  evidence.loop=evidence;
  evidence.proxy=new Proxy({},{ownKeys:forbidden});
  evidence.fn=forbidden;
  evidence.array=['one'];Object.defineProperty(evidence.array,'1',{enumerable:true,get:forbidden});
  let deep=evidence.deep={};for(let i=0;i<80;i++)deep=deep.next={};
  return {
    send:async()=>{onEvent({type:'tool',id:'tool-boundary',name:'fixture',input:evidence,status:'started'});return {sessionId:${JSON.stringify(SESSION)},answer:'safe answer',usage:{input_tokens:1,output_tokens:1,cache_read_tokens:null,cache_write_tokens:null,cost_usd:null},evidence};},
    close:async()=>{},
  };
}`;
  await f.put(preload, `import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){return url===${JSON.stringify(new URL('../dist/native/runtime.js', import.meta.url).href)}?{format:'module',shortCircuit:true,source:${JSON.stringify(source)}}:nextLoad(url,context);}});
`);
  const remote = bridge(t, f, ['--import', preload]);
  const target = (await remote.call('discover', { payload: { project: f.project, runtime: 'claude-code' } })).result.targets[0];
  const prepared = await remote.call('prepare', { target });
  await remote.call('open', { target, session_key: 'boundary-session', payload: { expected_fingerprint: prepared.result.target.fingerprint } });
  const response = await remote.call('send', { id: 'boundary-request', target, session_key: 'boundary-session', payload: { prompt: 'Synthetic boundary test' } });
  assert.equal(response.id, 'boundary-request');
  assert.equal(response.result.answer, 'safe answer');
  assert.equal(response.result.evidence.safe, 'kept');
  for (const name of ['secret', 'accessor', 'loop', 'proxy', 'fn']) assert.equal(response.result.evidence[name], '[redacted]');
  assert.deepEqual(response.result.evidence.array, ['one', '[redacted]']);
  assert.ok(JSON.stringify(response.result.evidence.deep).includes('[redacted]'));
  const event = remote.messages.find(message => message.event?.type === 'tool');
  assert.equal(event.session_key, 'boundary-session');
  assert.equal(event.event.input.accessor, '[redacted]');
  await remote.call('close', { target, session_key: 'boundary-session' });
  assert.ok(!remote.diagnostics().includes('unsafe-payload-executed'));
  assert.ok(!remote.raw.join('\n').includes(SECRET));
});
