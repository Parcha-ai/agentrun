import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { serve, follow } from './support.mjs';
import { nativeFixture } from './native-fixtures/setup.mjs';
import { openSqliteStore } from '../dist/store/index.js';
import { createDispatchLoop } from '../dist/runner/dispatch.js';
import { createNativeLoop } from '../dist/runner/native-loop.js';
import { startRunner } from '../dist/runner/runner.js';
import { secretRedactor } from '../dist/runner/redact.js';
import { journalRecords } from '../dist/runner/journal-reader.js';
import { putSealedKey } from '../dist/server-keys.js';
import { KINDS } from '../dist/runner/journal-kinds.js';

const secret = `native-fixture-${'q7'.repeat(16)}`;
const stored = `stored-native-${'v8'.repeat(16)}`;
const numeric = '8123456789';
const sealKey = Buffer.alloc(32, 7);
for (const runtime of ['claude-code', 'codex']) for (const redactor of ['held-values', 'text-only']) {
  test(`${runtime} with ${redactor} redaction cuts a held credential before native tool records and its final answer reach durable storage`, { timeout: 30_000 }, async t => {
    let runner, store;
    t.after(async () => { await runner?.close(); await store?.close(); });
    const fixture = await nativeFixture(t);
    const env = { ...fixture.env, NATIVE_TEST_ECHO: `${secret}|${stored}`, NATIVE_TEST_SECRET: secret };
    const names = ['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'NATIVE_TEST_LOG', 'NATIVE_TEST_ECHO', 'NATIVE_TEST_SECRET'];
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) process.env[name] = env[name];
    t.after(() => { for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } });
    const { api, data, store: reader } = await serve(t, { runner: false });
    await putSealedKey(reader, sealKey, 'MONID_API_KEY', stored);
    await putSealedKey(reader, sealKey, 'PARALLEL_API_KEY', numeric);
    const connected = await api('POST', '/native/connect', { project: fixture.project, runtime });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const agentId = connected.body.agent.agent_id;
    assert.equal((await api('PUT', `/agents/${agentId}/definition`, { definition: { instructions: '', learning: false } })).status, 200);
    store = await openSqliteStore({ dataDir: data, role: 'runner' });
    runner = startRunner({
      store, name: 'native-journal-redact', redact: redactor === 'held-values' ? secretRedactor([secret, numeric]) : text => text.replaceAll(secret, '[redacted]'),
      leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30,
      createLoop: createDispatchLoop({ launchOf: runId => store.runs.launch(runId), resolve: (_name, launch) => createNativeLoop(launch, { store, data, sealKey }) }),
    });
    const start = await api('POST', `/agents/${agentId}/runs`, { input: { content: 'Answer once and report the tool result.' } });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    await follow(api, start.body.run_id, ['completed']);
    const row = await reader.runs.get(start.body.run_id);
    const { entries } = await journalRecords(reader.readJournal(start.body.run_id), BACKGROUND_CONTEXT);
    const toolStart = entries.find(entry => entry.kind === KINDS.callStart);
    const toolEnd = entries.find(entry => entry.kind === KINDS.callEnd);
    const end = entries.find(entry => entry.kind === KINDS.end);
    assert.ok(toolStart); assert.ok(toolEnd); assert.ok(end);
    const expected = safe => ({ nested: ['[redacted]|[redacted]', { safe }], keyed: { '[redacted]|[redacted]': { '[redacted]|[redacted]': 'safe' } }, numeric: '[redacted]', collision: '[redacted]' });
    assert.deepEqual(toolStart.data.input, expected(7));
    assert.deepEqual(toolEnd.data.output, expected(true));
    assert.equal(toolStart.data.callId, 'secret-tool'); assert.equal(toolEnd.data.callId, 'secret-tool');
    assert.equal(toolStart.data.tool, runtime === 'codex' ? 'dynamic_tool_call' : 'fixture');
    assert.equal(end.data.answer, 'answer [redacted]|[redacted]');
    assert.equal(row.state, 'ended'); assert.equal(row.outcome, 'completed');
    for (const credential of [secret, stored, numeric]) assert.equal(JSON.stringify(entries).includes(credential), false, 'no held or stored credential in the raw journal, before API filtering');
    await store.flush?.();
    const bytes = await Promise.all(['store.sqlite', 'store.sqlite-wal', 'store.sqlite-shm'].map(name => readFile(join(data, name)).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; })));
    for (const credential of [secret, stored, numeric]) assert.equal(bytes.some(bytes => bytes.includes(Buffer.from(credential))), false, 'no plaintext credential committed to SQLite or its WAL');
  });
}
