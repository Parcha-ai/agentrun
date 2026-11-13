import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './native-fixtures/setup.mjs';

const ANSWER = 'Résumé 東京 😺';
const INPUT = { query: '東京 ☕', étiquette: 'mañana' };
const OUTPUT = 'Trouvé: café 日本語 🌍';
const SESSION = '11111111-1111-4111-8111-111111111111';
const runtimeUrl = new URL('../dist/native/runtime.js', import.meta.url).href;
const discoveryUrl = new URL('../dist/native/discovery.js', import.meta.url).href;

// Split every raw child stdout chunk into one-byte data events before production listeners see it.
// The pipe's original chunk size and scheduler cannot affect where UTF-8 characters are split.
const SPLITTER = `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (child.stdout) {
    const emit = child.stdout.emit;
    child.stdout.emit = function (name, ...values) {
      if (name === 'data' && Buffer.isBuffer(values[0])) {
        for (const byte of values[0]) emit.call(this, name, Buffer.from([byte]));
        return true;
      }
      return emit.call(this, name, ...values);
    };
  }
  return child;
};
syncBuiltinESMExports();
`;

function protocol(runtime) {
  return runtime === 'claude-code' ? [
    { type: 'system', subtype: 'init', session_id: SESSION, model: 'fixture-model' },
    { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: ANSWER }, { type: 'tool_use', id: 'tool-1', name: 'lookup', input: INPUT }] } },
    { type: 'user', session_id: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: OUTPUT }] } },
    { type: 'result', subtype: 'success', session_id: SESSION, result: ANSWER, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
  ] : [
    { type: 'thread.started', thread_id: SESSION },
    { type: 'item.started', item: { id: 'tool-1', type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', arguments: INPUT } },
    { type: 'item.completed', item: { id: 'tool-1', type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', arguments: INPUT, result: OUTPUT, status: 'completed' } },
    { type: 'item.completed', item: { id: 'answer-1', type: 'agent_message', text: ANSWER } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } },
  ];
}

async function fixture(t, runtime, truncated = false) {
  const f = await nativeFixture(t);
  const wire = Buffer.from(protocol(runtime).map(event => JSON.stringify(event)).join('\n'));
  // A valid final JSON event has no newline; malformed trailing UTF-8 follows an otherwise completed stream.
  const output = truncated ? Buffer.concat([wire, Buffer.from('\n'), Buffer.from([0xf0, 0x9f])]) : wire;
  const cli = join(f.root, 'utf8-cli.mjs'), splitter = join(f.root, 'split-stdout.mjs');
  await f.put(splitter, SPLITTER);
  await f.put(cli, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.NATIVE_TEST_LOG, JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) console.log(${JSON.stringify(runtime === 'claude-code' ? '2.1.322' : '0.167.2')});
else if (args.includes('status')) console.log(JSON.stringify({ loggedIn: true }));
else { readFileSync(0); process.stdout.write(Buffer.from(${JSON.stringify(output.toString('base64'))}, 'base64')); }
`);
  await chmod(cli, 0o755);
  for (const name of ['claude', 'codex']) {
    const path = join(f.root, 'bin', name);
    await unlink(path); await symlink(cli, path);
  }
  return { ...f, splitter };
}

function local(f, runtime) {
  const source = `const { discoverNative } = await import(${JSON.stringify(discoveryUrl)});
const { openNativeSession } = await import(${JSON.stringify(runtimeUrl)});
const target = (await discoverNative({ project: ${JSON.stringify(f.project)}, runtime: ${JSON.stringify(runtime)} })).targets[0];
const events = [];
const session = await openNativeSession({ target, onEvent: event => events.push(event) });
try { console.log(JSON.stringify({ result: await session.send('Synthetic UTF-8 task', { timeoutMs: 3000 }), events })); }
catch (error) {
  let retry;
  try { await session.send('Never replay a failed native turn'); } catch (again) { retry = again.code; }
  console.log(JSON.stringify({ error: error.code, retry, events }));
} finally { await session.close(); }`;
  const child = spawnSync(process.execPath, ['--import', f.splitter, '--input-type=module', '--eval', source], { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function assertPreserved({ result, events }) {
  assert.equal(result.answer, ANSWER);
  assert.equal(result.sessionId, SESSION);
  assert.ok(events.some(event => event.type === 'text' && event.text === ANSWER));
  assert.deepEqual(events.find(event => event.type === 'tool' && event.status === 'started')?.input, INPUT);
  assert.equal(events.find(event => event.type === 'tool' && event.status === 'completed')?.output, OUTPUT);
}

for (const runtime of ['claude-code', 'codex']) {
  test(`${runtime} preserves byte-split UTF-8 answers and tool data through an unterminated final JSON line`, async t => {
    assertPreserved(local(await fixture(t, runtime), runtime));
  });

  test(`${runtime} rejects incomplete trailing UTF-8 after completed output and never replays the turn`, async t => {
    const f = await fixture(t, runtime, true);
    const result = local(f, runtime);
    assert.deepEqual([result.error, result.retry], ['protocol', 'unavailable']);
    assert.equal((await f.calls()).filter(call => call.args.includes('--print') || call.args.includes('exec')).length, 1);
  });

  test(`remote ${runtime} preserves byte-split UTF-8 through the source JSONL bridge`, async t => {
    const f = await fixture(t, runtime), events = [], waiting = new Map();
    const child = spawn(process.execPath, ['--import', f.splitter, fileURLToPath(new URL('../dist/native/remote-worker-bridge.js', import.meta.url))], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let next = 0, diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.event) { events.push(message.event); return; }
      const entry = waiting.get(message.id);
      if (entry) { waiting.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); }
    });
    child.on('exit', code => { for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Bridge exited ${code}: ${diagnostics}`)); } waiting.clear(); });
    t.after(async () => {
      child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGTERM'), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    });
    const call = (type, body = {}) => new Promise((resolve, reject) => {
      const id = `utf8-${++next}`;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Bridge ${type} timed out`)); }, 10_000);
      waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, type, ...body }) + '\n');
    });
    const target = (await call('discover', { payload: { project: f.project, runtime } })).targets[0];
    await call('prepare', { target });
    await call('open', { target, session_key: 'utf8-session' });
    const result = await call('send', { target, session_key: 'utf8-session', payload: { prompt: 'Synthetic UTF-8 task', timeout_ms: 3000 } });
    assertPreserved({ result, events });
    await call('close', { target, session_key: 'utf8-session' });
  });
}
