// The two stores the package ships, held to the store contract by the conformance suite a host runs on its own store.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileStore, memoryStore } from '@parcha/agentrun-dsl/recovery';
import { registerStoreConformance } from '@parcha/agentrun-dsl/recovery/testing';

const root = mkdtempSync(join(tmpdir(), 'agentrun-recovery-stores-'));
after(() => rmSync(root, { recursive: true, force: true }));

registerStoreConformance('memory store', () => memoryStore());
registerStoreConformance('file store', () => fileStore(mkdtempSync(join(root, 'run-'))));

// Beyond the contract: the journal these two stores share checks and writes in one step, so two writes for one effect
// asked for together cannot both pass.
for (const [name, create] of [['memory store', () => memoryStore()], ['file store', () => fileStore(mkdtempSync(join(root, 'run-')))]]) {
  test(`${name}: two admissions of one effect asked for together write one admission; two completions, one result`, async () => {
    const store = create();
    const journal = await store.open({ binding: 'binding-1' });
    const admitted = await Promise.all([journal.admit('e1', 'lookup', 'args-1', { n: 1 }), journal.admit('e1', 'lookup', 'args-1', { n: 2 })]);
    assert.deepEqual([admitted[0], admitted[1].status, journal.revision, journal.effects().length], ['new', 'unknown', 1, 1]);
    const completed = await Promise.allSettled([journal.complete('e1', { value: 'first' }, { n: 3 }), journal.complete('e1', { value: 'second' }, { n: 4 })]);
    assert.deepEqual(completed.map((outcome) => outcome.status), ['fulfilled', 'rejected']);
    assert.match(completed[1].reason.message, /^Effect e1 completes once$/);
    await journal.close();
    const next = await store.open({ binding: 'binding-1' });
    assert.deepEqual([next.state, next.revision, next.effects()], [{ n: 3 }, 2, [{ id: 'e1', name: 'lookup', argsHash: 'args-1', status: 'completed', session: null, result: { value: 'first' } }]]);
    await next.close();
  });
}
