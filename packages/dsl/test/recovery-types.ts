import type { RecoveryBinding, RecoveryEffect, RecoveryJournal, RecoveryNote, RecoveryStore } from '@parcha/agentrun-dsl/recovery';
import type {} from '@parcha/agentrun-dsl/recovery/testing';

declare const store: RecoveryStore;
const bound: RecoveryBinding = { binding: 'digest', inputs: { workflow: 'digest' } };

async function caller() {
  const id = 'effect-1';
  const journal: RecoveryJournal = await store.open(bound);
  const resumed: boolean = journal.existing;
  const owner: [number, number] = [journal.generation, journal.revision];
  const saved: number = await journal.save(revision => ({ escalation: { revision } }), { kind: 'escalation', detail: { step: 'review' } });
  const plain: number = await journal.save({ started: true });
  const noted: number = await journal.note('inherited', { tail: 'continuation' });
  const admitted = await journal.admit(id, 'lookup', 'digest', { started: true }, null);
  if (admitted !== 'new') {
    const status: 'unknown' | 'completed' = admitted.status;
    void status;
  }
  await journal.called(id, [{ tool: 'lookup' }]);
  await journal.complete(id, { value: 1, files: {} }, { started: true });
  await journal.complete(id, { value: 1, files: {} });
  const effect: RecoveryEffect | undefined = journal.effect(id);
  const held: [RecoveryEffect[], RecoveryNote[]] = [journal.effects(), journal.notes()];
  await journal.close();

  // @ts-expect-error a journal's ownership generation is fixed at open.
  journal.generation = 2;
  // @ts-expect-error notes are a closed set of kinds.
  await journal.note('progress', {});
  // @ts-expect-error an admission resolves to 'new' or the effect already held, never to nothing.
  const nothing: void = await journal.admit('other', 'lookup', 'digest', {});
  // @ts-expect-error a store is opened under a binding.
  await store.open();
  void [resumed, owner, saved, plain, noted, effect, held, nothing];
}
void caller;

// A store author writes one `save`: it takes either form of the state.
const authored: Pick<RecoveryJournal, 'save'> = {
  async save(state: unknown, note?: Pick<RecoveryNote, 'kind' | 'detail'>) {
    void [typeof state === 'function' ? state(1) : state, note];
    return 1;
  },
};
void authored;

// @ts-expect-error an effect is unknown or completed, nothing between.
const pending: RecoveryEffect = { id: 'e', name: 'lookup', argsHash: 'digest', status: 'pending', session: null, result: null };
void pending;
