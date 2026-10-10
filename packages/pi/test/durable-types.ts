import type { RecoveryJournal, RecoveryStore } from '@parcha/agentrun-dsl/recovery';
import type { RecoveryJournal as DurableJournal, RecoveryStore as DurableStore } from '@parcha/agentrun-pi/durable';

declare const contract: RecoveryStore;
declare const durable: DurableStore;
const asDurable: DurableStore = contract;
const asContract: RecoveryStore = durable;

async function caller() {
  const journal: RecoveryJournal = await durable.open({ binding: 'digest' });
  const same: DurableJournal = journal;
  // @ts-expect-error a durable store is opened under a binding, as every store is.
  await durable.open();
  void same;
}
void [asDurable, asContract, caller];
