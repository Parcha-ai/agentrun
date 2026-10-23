import { WorkflowStore, WorkflowStoreError, type StoredWorkflow, type WorkflowRevision } from '@parcha/agentrun-pi/workflows';
import type { Workflow } from '@parcha/agentrun-dsl';
declare const workflow: Workflow;
async function caller(store: WorkflowStore) {
  const saved: StoredWorkflow = await store.save('copy', workflow);
  const latest: StoredWorkflow = await store.load('copy');
  const exact: StoredWorkflow = await store.load('copy', saved.digest);
  const listed: WorkflowRevision[] = await store.list();
  const revision: WorkflowRevision = latest;
  const flow: Workflow = exact.workflow;
  const code: string = (new WorkflowStoreError('not_found', 'x')).code;
  // @ts-expect-error a store is built from a directory.
  new WorkflowStore();
  // @ts-expect-error a revision is named by its digest, a string.
  await store.load('copy', 1);
  // @ts-expect-error a listed revision carries no workflow.
  const body = listed[0]!.workflow;
  void [revision, flow, code, body];
}
void caller;
