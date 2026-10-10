// The handoff a run's escalation leaves for its continuation: built from the journal alone, byte-stable, redacted,
// bounded, and carrying the receipts a continuation may reuse and the unknowns it must not repeat.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildHandoff, handoffFirstTurn, memoryStore } from '@parcha/agentrun-dsl/recovery';

const root = mkdtempSync(join(tmpdir(), 'agentrun-handoff-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (text) => createHash('sha256').update(text).digest('hex');

const input = { question: 'Review acme ltd', context: { site: 'https://acme.example/about', owner: 'sam@acme.example', n: 3 }, files: ['/in/doc.pdf'] };
// Assembled at run time: a credential-shaped literal in a source file is what the source export refuses.
const secret = ['sk', 'abcdefghijklmnopqrstuvwxyz0123'].join('-');
const state = {
  applicant: { id: 'A-1', name: 'Acme Ltd', score: 0.8, notes: 'x'.repeat(300) },
  items: [{ id: 'i1', text: 'alpha\nbeta', s: 1 }, { id: 'i2', text: '{"k":[1,2]}', s: 2 }],
  api_key: secret, big: ['a', 'b'],
};
const effects = [
  { id: 'e1', name: 'lookup', argsHash: 'h1', status: 'completed', session: 'run:lookup:step:/root:a1', result: { intent: { tool: 'search', args: { q: 'acme' } }, value: 'found 3 hits Bearer abcdefghijkl', files: { 'out.txt': 'ff' } } },
  { id: 'e2', name: 'fetch', argsHash: 'h2', status: 'completed', session: 'run:lookup:step:/root:a1', result: { intent: { tool: 'page', args: { u: 1 } }, value: { ok: false } } },
  { id: 'e3', name: 'pay', argsHash: 'h3', status: 'unknown', session: null, result: null },
];
const row = (over = {}) => ({ kind: 'gate', stage: 'review', summary: 'needs a human: owner sam@acme.example unclear', state, workflow_sha_used: 'abcdef0123456789abcdef', pin_sha256: 'p', step_label: 'review', step_exec_id: 'x1', cost_usd: 0.1234, turns: 3, effect_calls: 2, evidence_dir: '', tail: 't', revision: 5, ...over });
const routes = { '/root/a': { label: 'r', branch: 'b', choice: 'c', unsure: false, request_sha256: null, result: { choice: 'c' }, receipts: null } };
const sessions = [{ id: 'run:lookup:step:/root:a1', role: 'step', state: 'closed', file: null, spend: { turns: 2, usd: 0.05, state: 'complete' } }];
const messages = [
  { role: 'user', content: 'find acme' },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'acme' } }, { type: 'text', text: `done with ${secret}` }] },
  { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'hits' }] },
];
const budget = { max_tool_calls: 8, max_seconds: 40 };

/** A journal that a first process committed an escalation to and a second process opened, as a continuation does. */
async function committed(cwd, escalation = row({ evidence_dir: join(cwd, 'evidence') })) {
  const store = memoryStore();
  const writer = await store.open({ binding: 'b' });
  const full = { pin: { routes }, files: { 'out.txt': 'ab'.repeat(32) }, ...(escalation ? { escalation } : {}) };
  for (const e of effects) { await writer.admit(e.id, e.name, e.argsHash, full, e.session); if (e.status === 'completed') await writer.complete(e.id, e.result, full); }
  if (!effects.length) await writer.save(full);
  await writer.close();
  return store.open({ binding: 'b' });
}
function workspace(name) {
  const cwd = join(root, name);
  mkdirSync(join(cwd, 'evidence'), { recursive: true });
  writeFileSync(join(cwd, 'evidence', 'gathered.txt'), 'g');
  writeFileSync(join(cwd, 'out.txt'), 'data');
  return cwd;
}
const options = (cwd) => ({ cwd, runId: 'run', input, budget, sessions, transcriptOf: (id) => id === sessions[0].id ? messages : null });
const filesOf = (cwd) => readdirSync(join(cwd, 'evidence/frozen'), { recursive: true }).sort()
  .map((name) => { const full = join(cwd, 'evidence/frozen', name); return statSync(full).isFile() ? `${name}:${readFileSync(full, 'utf8')}` : name; }).join('\n');

test('the block, the digest and the attempt files are byte-stable, and equal what the first build wrote', async () => {
  const cwd = workspace('stable');
  const journal = await committed(cwd);
  const handoff = await buildHandoff(journal, options(cwd));
  const at = (text) => text.split(cwd).join('<W>');
  assert.equal(sha(at(handoff.block)), '531c2f14c681d9894345bc9be633bf0b1e985836f49923192e394d6bb7bb1e7e');
  assert.equal(sha(at(handoff.digest)), '5e7b4e5e6a432643cd7d97724ac27731a829278e91be3cda2a52a9238681baa6');
  assert.equal(sha(at(filesOf(cwd))), '2e3bd053fbc23506cdb7688b0c7d59b67d15ddeba3f726c4875825b902fad23a');
  const again = await buildHandoff(journal, options(cwd));
  assert.deepEqual(again, handoff);
  assert.equal(handoffFirstTurn(handoff), `${handoff.block}\n\n${handoff.digest}`);
  await journal.close();
});

test('no credential reaches the block, the digest or a file, and no email address reaches the block or the digest', async () => {
  const cwd = workspace('redacted');
  const journal = await committed(cwd);
  const handoff = await buildHandoff(journal, options(cwd));
  const everything = [handoff.block, handoff.digest, filesOf(cwd)].join('\n');
  for (const leaked of [secret, 'abcdefghijkl']) assert.equal(everything.includes(leaked), false, leaked);
  // The files keep an identifier whole for the continuation to read; the text it is handed first does not carry one.
  assert.equal([handoff.block, handoff.digest].join('\n').includes('sam@acme.example'), false);
  assert.match(handoff.block, /<redacted email>/);
  await journal.close();
});

test('receipts are the completed tool effects that returned a result; unknowns are the effects nobody can vouch for', async () => {
  const cwd = workspace('receipts');
  const journal = await committed(cwd);
  const handoff = await buildHandoff(journal, options(cwd));
  assert.deepEqual(handoff.receipts.map(({ id, tool, session }) => ({ id, tool, session })), [{ id: 'e1', tool: 'search', session: 'run:lookup:step:/root:a1' }]);
  assert.deepEqual(handoff.unknown.map(({ id, name }) => ({ id, name })), [{ id: 'e3', name: 'pay' }]);
  await journal.close();
});

test('a state beyond the block\'s budget is pointed at, never sliced, and the closing instruction stays', async () => {
  const cwd = workspace('bounded');
  const huge = { ...state, many: Array.from({ length: 4000 }, (_, i) => ({ id: `r${i}`, text: 'y'.repeat(40) })) };
  const journal = await committed(cwd, row({ state: huge, evidence_dir: join(cwd, 'evidence') }));
  const handoff = await buildHandoff(journal, options(cwd));
  assert.match(handoff.block, /State body is \d+ chars \(\d+ keys\), beyond what this text carries; read it whole in `evidence\/frozen\/state\.json`/);
  assert.match(handoff.block, /Continue the job from this state\. Do not redo completed work/);
  assert.equal(handoff.files.filter((file) => file.startsWith('evidence/frozen/items/')).length, 1000);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'evidence/frozen/state.json'), 'utf8')).many.length, 4000);
  await journal.close();
});

test('a journal with no committed escalation has no handoff', async () => {
  const cwd = workspace('none');
  const journal = await committed(cwd, null);
  await assert.rejects(buildHandoff(journal, options(cwd)), /escalation the driver committed/);
  await journal.close();
});

test('a step whose transcript is missing says so, and the digest still closes', async () => {
  const cwd = workspace('missing');
  const journal = await committed(cwd);
  const handoff = await buildHandoff(journal, { ...options(cwd), transcriptOf: () => null });
  assert.match(handoff.digest, /- transcript unavailable/);
  assert.match(handoff.digest, /You are continuing this job, not restarting it\./);
  await journal.close();
});
