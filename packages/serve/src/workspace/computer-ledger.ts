// The ledger a provider takes when its sessions carry no labels of their own (the phone provider's `ledger` option,
// PhoneLedger): each session's whole entry, kept by its id in the store's computer ledger, so the provider's list, an
// attach by labels and the janitor outlive a restart of the server. The labels go in their own column; the rest of the
// entry (a phone's image and deadline) is kept as the provider gave it. Every read is a fresh copy, as the provider's
// own in-memory ledger gives.
import type { ComputerLedger, ComputerLedgerRow } from "../store/store.js";

/** A session's entry as a provider keeps it: its id, our labels, and the provider's own fields. */
export interface LedgerEntry {
  id: string;
  labels: Record<string, string>;
}

/** One provider's ledger, in the shape its `ledger` option takes (the phone provider's PhoneLedger). */
export interface ProviderLedger<E extends LedgerEntry = LedgerEntry> {
  put(entry: E): Promise<void>;
  get(id: string): Promise<E | undefined>;
  list(): Promise<E[]>;
  remove(id: string): Promise<void>;
}

const entryOf = <E extends LedgerEntry>({ sessionId, labels, detail }: ComputerLedgerRow): E => ({ ...detail, id: sessionId, labels: { ...labels } }) as unknown as E;

/** `provider`'s ledger over the store's computer ledger. */
export function storeLedger<E extends LedgerEntry = LedgerEntry>(ledger: ComputerLedger, provider: string): ProviderLedger<E> {
  return {
    put: async (entry) => {
      const { id, labels, ...detail } = entry;
      await ledger.put(provider, id, labels, detail);
    },
    get: async (id) => {
      const row = await ledger.get(provider, id);
      return row === undefined ? undefined : entryOf<E>(row);
    },
    list: async () => (await ledger.list(provider)).map((row) => entryOf<E>(row)),
    remove: (id) => ledger.remove(provider, id),
  };
}
