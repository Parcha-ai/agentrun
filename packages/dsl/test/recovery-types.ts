import { runWorkflow, type Workflow, type WorkflowDeps } from '@parcha/agentrun-dsl';
import {
  openRecovery, withRecovery, memoryStore, fileStore, workspaceFiles, RecoveryError,
  type RecoveryBinding, type RecoveryDriver, type RecoveryEffect, type RecoveryIntent, type RecoveryJournal, type RecoveryNote, type RecoveryStore, type EscalationRow, type FrozenSnapshot,
} from '@parcha/agentrun-dsl/recovery';
import { registerStoreConformance } from '@parcha/agentrun-dsl/recovery/testing';

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
    const intent: RecoveryIntent | undefined = admitted.intent;
    void [status, intent];
  }
  const call: RecoveryIntent = { tool: 'registry_lookup', argsHash: 'digest' };
  await journal.admit('tool-1', 'lookup', 'digest', { started: true }, 'run-1', call);
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
  // @ts-expect-error an intent names the tool and the hash of its arguments, not the arguments.
  await journal.admit('tool-2', 'lookup', 'digest', {}, null, { tool: 'registry_lookup', args: {} });
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

// A host opens the driver over a store, runs the interpreter with its adapters wrapped, and closes it.
declare const workflow: Workflow;
async function host(deps: WorkflowDeps) {
  const stores: RecoveryStore[] = [memoryStore(), fileStore('runs/one')];
  const driver: RecoveryDriver = await openRecovery(stores[0], workflow, { key: 'run-1', bind: { config: { question: 'q' } }, reservedOutputs: ['report.md'], files: workspaceFiles('.') });
  const wrapped: WorkflowDeps = withRecovery(driver, {
    ...deps,
    runEffect: async ({ input, call }) => { call?.({ tool: 'lookup', input }); return { value: 1 }; },
    // A node runner is handed the attempt it runs; a plain interpreter runner, which ignores it, fits too.
    runNode: async ({ label, step }) => ({ label, session: step?.sessionId, attempt: step?.attempt, earlier: step?.earlierSessionIds.length }),
  }, { durableNodes: true });
  const plain: WorkflowDeps = withRecovery(driver, deps);
  // @ts-expect-error the wrapper's options are its own.
  withRecovery(driver, deps, { durableNodes: 'yes' });
  const result = await runWorkflow(workflow, {}, wrapped);
  driver.stop({ action: 'pause', source: 'operator' });
  const row: EscalationRow | undefined = driver.escalation();
  const resumed: boolean = driver.resumed;
  await driver.close();
  // @ts-expect-error a run is opened under its key.
  await openRecovery(stores[1], workflow, {});
  // @ts-expect-error a stop is a pause or a cancel.
  driver.stop({ action: 'restart' });
  void [result, row, resumed, plain];
}
void host;
const refusal: { code: string; source?: string } = new RecoveryError('refused', 'FROZEN_EFFECT_UNKNOWN');
const schema: FrozenSnapshot['schema'] = 'agentrun.frozen_run.v3';
registerStoreConformance satisfies (name: string, create: () => RecoveryStore | Promise<RecoveryStore>) => void;
void [refusal, schema];
