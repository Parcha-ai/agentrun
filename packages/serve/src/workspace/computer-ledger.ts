// The ledger a provider takes when its sessions carry no labels of their own (the phone provider): ours (the run, the
// claim's epoch...) kept by session id in the store's computer ledger, so the provider's list, an attach by labels and the
// janitor outlive a restart of the server.
import type { ComputerLedger } from "../store/store.js";

/** One provider's view of the ledger: its sessions' labels by session id. */
export interface ProviderLedger {
  put(sessionId: string, labels: Readonly<Record<string, string>>): Promise<void>;
  get(sessionId: string): Promise<Readonly<Record<string, string>> | undefined>;
  list(): Promise<{ sessionId: string; labels: Readonly<Record<string, string>> }[]>;
  remove(sessionId: string): Promise<void>;
}

/** `provider`'s ledger over the store's computer ledger. */
export const storeLedger = (ledger: ComputerLedger, provider: string): ProviderLedger => ({
  put: (sessionId, labels) => ledger.put(provider, sessionId, labels),
  get: async (sessionId) => (await ledger.get(provider, sessionId))?.labels,
  list: async () => (await ledger.list(provider)).map(({ sessionId, labels }) => ({ sessionId, labels })),
  remove: (sessionId) => ledger.remove(provider, sessionId),
});
