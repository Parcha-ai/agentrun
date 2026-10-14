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

// The decision rows: a host's Session opens with a pi-durable Harness, and a row is the stored version.
import type { Harness } from '@earendil-works/pi-durable';
import { createDecisionWriter, type DecisionRow, type DecisionSession, type DecisionWriter } from '@parcha/agentrun-pi/durable';

declare const harness: Harness;
declare const row: DecisionRow;
const session: DecisionSession = { harness, release: async () => {} };
const writer: DecisionWriter = createDecisionWriter({ open: async () => session });
writer.record(row);
// @ts-expect-error a stored row is version 1.
const later: DecisionRow = { ...row, v: 2 };
void [writer, later];

// decisionRecovery's hooks are the interpreter's own, over a workflow task's invocation.
import type { WorkflowDeps } from '@parcha/agentrun-dsl';
import { decisionRecovery, type WorkflowInvocation } from '@parcha/agentrun-pi/durable';

declare const invocation: WorkflowInvocation;
const decisions = decisionRecovery(invocation);
const recordDecision: NonNullable<WorkflowDeps['recordDecision']> = decisions.recordDecision;
const decision: NonNullable<NonNullable<WorkflowDeps['recovery']>['decision']> = decisions.decision;
void [recordDecision, decision];
