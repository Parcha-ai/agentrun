// A handoff built from a run stored in the keyed (v4) layout. The driver keeps what a map item produced — its files above
// all — in the item's own record, not the driver's. buildHandoff must read those records the one way the driver's restore
// does (restore-keyed.ts, shared), or a file a map item produced is dropped from the handoff digest while a whole-state (v3)
// run keeps it. Regression for that divergence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildHandoff, openRecovery, withRecovery, openJournal, recoveryBound, workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { runWorkflow } from '@parcha/agentrun-dsl';

const KEY = 'run-k';
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A memory journal whose record the test can read, and which exposes items/stateOf (so the keyed layout is eligible). */
function inspectable() {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  return { store: { open: (bound) => openJournal(backend, bound) }, record: () => record };
}

// A map whose item produces a file, then an escalate at the top level. The produced file is owned by the map item.
const workflow = {
  v: 2, name: 'v4-handoff',
  schemas: { Input: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } }, Rendered: { type: 'object' }, Result: { type: 'object' } },
  input: { schemaId: 'Input' }, output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'items', as: 'found', resultPath: 'rendered',
      body: { node: 'call', label: 'render', via: 'shell', command: 'render', produces: ['item.json'], deadline_s: 5, as: 'rendered' } },
    { node: 'escalate', label: 'gate', when: { predicate: 'empty', path: 'never_set' }, kind: 'human_review', stage: 'review', summary: 'need a human' },
    { node: 'code', label: 'done', code: '() => ({ result: { ok: true } })' },
  ] },
};
const input = { items: [{ id: 'x' }] };

const roots = [];
after(() => { /* workspaces are under the OS tmp dir; left for the OS to reap */ });

/** Run the workflow in `layout`, commit the escalation, then build the handoff. Returns the digest's produced-files line. */
async function handoffFilesLine(layout) {
  const cwd = mkdtempSync(join(tmpdir(), `v4ho-${layout}-`)); roots.push(cwd);
  mkdirSync(join(cwd, 'evidence'), { recursive: true });
  const kept = inspectable();
  const deps = { runEffect: async () => { writeFileSync(join(cwd, 'item.json'), 'rendered bytes'); return { code: 0, stdout: '', stderr: '' }; } };
  const driver = await openRecovery(kept.store, workflow, { key: KEY, layout, files: workspaceFiles(cwd) });
  const wrapped = withRecovery(driver, deps);
  const out = await runWorkflow(workflow, input, wrapped);
  assert.equal(out.status, 'escalated', `${layout}: the run escalates`);
  await driver.escalate({ kind: out.escalation.kind, stage: out.escalation.stage, summary: out.escalation.summary, state: out.escalation.state,
    workflow_sha_used: 'w', pin_sha256: 'p', step_label: 'gate', step_exec_id: null, cost_usd: 0, turns: 0, effect_calls: 0, evidence_dir: join(cwd, 'evidence') });
  const effective = driver.layout?.schema;
  await driver.close();
  const journal = await kept.store.open(recoveryBound(workflow));
  const handoff = await buildHandoff(journal, { cwd, runId: KEY, transcriptOf: () => null, workflow });
  await journal.close();
  const section = (handoff.digest ?? '').split('### Files produced in the workspace')[1]?.split('###')[0] ?? '';
  return { effective, section: section.trim() };
}

test("a file a map item produced reaches the handoff digest in the keyed layout, as it does whole", async () => {
  const v4 = await handoffFilesLine('v4');
  assert.equal(v4.effective, 'agentrun.frozen_run.v4', 'the run is stored in the keyed layout');
  assert.match(v4.section, /item\.json .* sha256 /, 'the map item\'s produced file is listed, read from its item record');
  // The whole-state layout keeps the same file at the top level; both handoffs list it.
  const v3 = await handoffFilesLine('v3');
  assert.equal(v3.effective, 'agentrun.frozen_run.v3');
  assert.match(v3.section, /item\.json .* sha256 /);
  assert.equal(v4.section, v3.section, 'the keyed handoff lists the item\'s file exactly as the whole-state one does');
});
