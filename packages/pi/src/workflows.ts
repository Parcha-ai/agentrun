// Saved workflows for a host: the store the /agentrun extension keeps for its project directory, against a directory the host passes.
// It loads nothing from pi, so a host that never runs the extension can import it.
export { WorkflowStore, WorkflowStoreError, type StoredWorkflow, type WorkflowRevision } from './workflow-store.js';
