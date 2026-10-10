// Stores that each break one rule of the store contract, for the test that shows the conformance suite catches them.
// Run by recovery-conformance-mutants.test.mjs, one mutant per process, named by RECOVERY_MUTANT.
import { memoryStore, openJournal } from '@parcha/agentrun-dsl/recovery';
import { registerStoreConformance } from '@parcha/agentrun-dsl/recovery/testing';

/** A memory backend whose parts a mutant replaces. */
function backend(overrides = {}) {
  let record; let owned = false;
  return {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
    ...overrides,
  };
}
const over = (store, wrap) => ({ open: async (bound) => wrap(await store.open(bound)) });

export const MUTANTS = {
  // The control: the suite passes on a store that keeps every rule.
  none: () => memoryStore(),
  // The admission is written without the state that admits it.
  'admit-without-its-state': () => over(memoryStore(), (journal) => {
    let last = journal.state;
    return Object.assign(Object.create(journal), {
      save: async (state, note) => { const revision = await journal.save(state, note); last = typeof state === 'function' ? state(revision) : state; return revision; },
      admit: (id, name, argsHash, _state, session) => journal.admit(id, name, argsHash, last, session),
    });
  }),
  // A second open of a live journal is let in.
  'two-owners': () => { const shared = backend({ acquire: async () => async () => {} }); return { open: (bound) => openJournal(shared, bound) }; },
  // The binding the journal was first opened under is never compared.
  'binding-unchecked': () => { const shared = backend(); let first; return { open: (bound) => openJournal(shared, first ??= bound) }; },
  // Effects are not read back at open.
  'effects-forgotten': () => { const shared = backend(); return { open: (bound) => openJournal({ ...shared, read: async () => { const record = await shared.read(); return record && { ...record, effects: [] }; } }, bound) }; },
  // An admission whose state cannot be stored still writes the effect.
  'half-an-admission': () => over(memoryStore(), (journal) => Object.assign(Object.create(journal), {
    admit: async (id, name, argsHash, state, session) => {
      try { return await journal.admit(id, name, argsHash, state, session); }
      catch (error) { await journal.admit(id, name, argsHash, null, session); throw error; }
    },
  })),
  // A closed journal still commits.
  'commits-after-close': () => { const shared = backend(); return over({ open: (bound) => openJournal(shared, bound) }, (journal) => Object.assign(Object.create(journal), { close: async () => {} })); },
};

const name = process.env.RECOVERY_MUTANT;
if (name) registerStoreConformance(name, MUTANTS[name]);
