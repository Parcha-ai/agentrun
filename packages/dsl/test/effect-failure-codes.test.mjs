// Effect failure codes: every EffectFailure carries a closed code (EFFECT_FAILURE_CODES), named by the
// host or implied by its retry class; every `effect.failed` event carries the code and the host's
// detail; `retry.on` names codes as well as retry classes, and a code in it retries while another does
// not. The denied-global lint names the globals a code body reaches for, so a host that runs code from
// an untrusted author can refuse it before it runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow, validateWorkflow, EffectFailure, EFFECT_FAILURE_CODES, CALL_RETRY_CLASSES, deniedGlobalReferences } from '../dist/index.js';

const schemas = { Out: { type: 'object', required: ['code'], properties: { code: { type: 'integer' } } } };
const shell = (retry) => ({ node: 'call', label: 'render', via: 'shell', command: 'render.sh', as: 'render', deadline_s: 5, ...(retry ? { retry } : {}) });
const flow = (node) => ({ v: 2, name: 'codes', schemas, output: { schemaId: 'Out', path: 'final' }, root: { node: 'chain', steps: [node, { node: 'code', label: 'finish', code: '(s) => ({ final: { code: s.render.code } })' }] } });
const ok = { code: 0, stdout: '', stderr: '', truncated: false };

test('the closed code list, and a retry class implies its code', () => {
  assert.deepEqual([...EFFECT_FAILURE_CODES], ['effect_timeout', 'effect_exit', 'effect_transport', 'effect_not_granted', 'effect_produces_missing', 'effect_path_escape', 'effect_code_unsafe', 'output_invalid', 'state_invalid', 'effect_unknown_transport']);
  assert.equal(new EffectFailure('x', 'timeout').code, 'effect_timeout');
  assert.equal(new EffectFailure('x', 'exit').code, 'effect_exit');
  for (const transient of ['http_5xx', 'http_429', 'connection']) assert.equal(new EffectFailure('x', transient).code, 'effect_transport');
  assert.equal(new EffectFailure('x').code, null);
  const typed = new EffectFailure('x', null, { code: 'effect_path_escape', detail: { path: '../x' }, cause: new Error('root') });
  assert.equal(typed.code, 'effect_path_escape');
  assert.deepEqual(typed.detail, { path: '../x' });
  assert.equal(typed.cause.message, 'root');
});

test('retry.on validates codes and retry classes, and nothing else', () => {
  for (const name of [...CALL_RETRY_CLASSES, ...EFFECT_FAILURE_CODES]) assert.deepEqual(validateWorkflow(flow(shell({ attempts: 2, on: [name] }))), { ok: true }, name);
  const refused = validateWorkflow(flow(shell({ attempts: 2, on: ['effect_exploded'] })));
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join('\n'), /retry\.on may name only timeout\|http_5xx\|http_429\|connection\|exit\|effect_timeout\|/);
});

test('retry.on a code retries a failure with that code; another code does not; every effect.failed event carries the code and the detail', async () => {
  const run = async (on) => {
    const events = [];
    let calls = 0;
    const result = await runWorkflow(flow(shell({ attempts: 3, backoff_s: 0, on })), {}, {
      onEvent: (event) => { if (event.type === 'effect.failed') events.push(event.detail); },
      runEffect: async () => {
        calls += 1;
        if (calls === 1) throw new EffectFailure('the promised file is empty', null, { code: 'effect_produces_missing', detail: { path: 'out.mp4' } });
        return ok;
      },
    }).then((r) => r.status, (error) => error);
    return { result, calls, events };
  };
  const retried = await run(['effect_produces_missing']);
  assert.equal(retried.result, 'complete');
  assert.equal(retried.calls, 2);
  assert.equal(retried.events[0].code, 'effect_produces_missing');
  assert.equal(retried.events[0].path, 'out.mp4', "the host's detail is on the event");
  assert.equal(retried.events[0].retrying, true);
  assert.equal(retried.events[0].retry_class, null);

  const refused = await run(['effect_exit', 'timeout']);
  assert.ok(refused.result instanceof EffectFailure);
  assert.equal(refused.calls, 1, 'a code the node does not name is not retried');
  assert.equal(refused.events[0].code, 'effect_produces_missing');
  assert.equal(refused.events[0].retrying, false);
});

test('a retry class still retries as before: the default list and a named class', async () => {
  let calls = 0;
  const events = [];
  const result = await runWorkflow(flow(shell({ attempts: 2, backoff_s: 0 })), {}, {
    onEvent: (event) => { if (event.type === 'effect.failed') events.push(event.detail); },
    runEffect: async () => { calls += 1; if (calls === 1) throw new EffectFailure('exited 5', 'exit'); return ok; },
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls, 2);
  assert.equal(events[0].code, 'effect_exit');
  assert.equal(events[0].retry_class, 'exit');
});

test('the interpreter\'s own deadline failure carries effect_timeout', async () => {
  const events = [];
  await assert.rejects(runWorkflow(flow({ ...shell(), deadline_s: 0.05 }), {}, {
    onEvent: (event) => { if (event.type === 'effect.failed') events.push(event.detail); },
    runEffect: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })),
  }));
  assert.equal(events[0].code, 'effect_timeout');
});

test('the denied-global lint names what a body reaches for, and not what it only mentions', () => {
  assert.deepEqual(deniedGlobalReferences('(s) => ({ pid: process.pid, ok: require("fs") })'), ['require', 'process']);
  assert.deepEqual(deniedGlobalReferences('(s) => { const r = fetch("https://x"); return { r }; }'), ['fetch']);
  assert.deepEqual(deniedGlobalReferences('(s) => globalThis.fetch'), ['globalThis']);
  assert.deepEqual(deniedGlobalReferences('(s) => ({ ...process.env })'), ['process']);
  assert.deepEqual(deniedGlobalReferences('(s) => `${Date.now()}`'), ['Date']);
  // Property names, string and template text, comments and regular expressions are not references.
  assert.deepEqual(deniedGlobalReferences('(s) => ({ n: s.process, m: s?.fetch, t: "process", u: `require ${s.x}` })'), []);
  assert.deepEqual(deniedGlobalReferences('(s) => { /* process */ // fetch\n return { ok: /process|fetch/.test(s.text) }; }'), []);
  assert.deepEqual(deniedGlobalReferences('(s) => ({ total: s.items.length / 2 })'), []);
});

test('the effect.failed row\'s code is closed: an open code rides as error_code, and an unknown outcome under recovery carries none', async () => {
  const rows = [];
  const onEvent = (event) => { if (event.type === 'effect.failed') rows.push(event.detail); };
  // A host error with its own string code, and an EffectFailure forged with a code outside the list.
  class ReceiptsFailure extends Error { code = 'RECEIPT_WRITE_FAILED'; }
  await assert.rejects(runWorkflow(flow(shell()), {}, { onEvent, runEffect: async () => { throw new ReceiptsFailure('row lost'); } }));
  await assert.rejects(runWorkflow(flow(shell()), {}, { onEvent, runEffect: async () => { throw new EffectFailure('forged', null, { code: 'effect_exploded' }); } }));
  // An adapter still pending at its deadline under recovery: the outcome is unknown.
  const recovery = { supportsExecutionPaths: true, resume: async () => undefined, commit: async () => {}, pollStartedAt: () => Date.now(), wait: async () => {} };
  await assert.rejects(runWorkflow(flow({ ...shell(), deadline_s: 0.05 }), {}, { onEvent, recovery, runEffect: () => new Promise(() => {}) }));
  assert.deepEqual(rows.map((row) => [row.code, row.error_code ?? null]), [[null, 'RECEIPT_WRITE_FAILED'], [null, 'effect_exploded'], [null, 'effect_outcome_unknown']]);
  assert.equal(rows[2].outcome, 'unknown');
  for (const row of rows) assert.ok(row.code === null || EFFECT_FAILURE_CODES.includes(row.code));
});
