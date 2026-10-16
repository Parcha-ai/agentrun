// @parcha/agentrun-dsl/browser: what a page needs to hold a workflow document: validate it, inspect it, dry-run it, hash
// it, and the types of all of that. It reaches no `node:` built-in, no `Buffer`, no `eval` and no `new Function`, so it
// bundles for the browser platform as is. It has no executor and no recovery: nothing here calls a model, a tool or a
// store. A code node is never compiled here; it runs only through the host's `runCode` (see ./worker for a Web Worker
// that serves these functions with the host's runCode).
import { validateWorkflow as validate } from "../workflow.js";
import type { Workflow } from "../workflow.js";

/** `validateWorkflow` for a page: the same checks of shape, schemas, state paths, reachability and bounds, with a code
 *  node's source left unparsed (the browser has no code compiler; the host's `runCode` owns code). A syntax error in a
 *  code node therefore shows when the code runs, in the host's `runCode`, not at validation. */
export const validateWorkflow = (workflow: Workflow, opts: Parameters<typeof validate>[1] = {}): ReturnType<typeof validate> =>
  validate(workflow, { ...opts, executeCode: false });

export { workflowSha256, WorkflowInvalidError, WorkflowInputInvalidError, WorkflowOutputInvalidError } from "../workflow.js";
export type {
  Workflow, WorkflowNode, NodeMetadata, WorkflowDeps, HostPolicy, Escalation, MapItem,
  LlmNode, JudgeNode, PickNode, SiftNode, RouteNode, RouteByJudgmentNode, RouteByValueNode, WorkflowInvocation,
  ArtifactNode, ArtifactState, CallNode, CodeNode, CallRetryClass, EffectFailureCode, CallPredicate, PollClause,
  ModelTier, AgentContext, WorkflowEffort, WorkflowThinking, VerifyClause,
  AskPredicate, MechanicalPredicate, Predicate,
} from "../workflow.js";
export { dryRunWorkflow, synthesizeInstance } from "../dry-run.js";
export type { DryRunOptions, DryRunResult } from "../dry-run.js";
export { inspectWorkflow, formatWorkflowTree } from "../inspection.js";
export type { WorkflowInspection, WorkflowInspectionNode } from "../inspection.js";
export {
  WORKFLOW_NODE_KINDS, GENERATIVE_NODE_KINDS, JUDGMENT_NODE_KINDS, NODE_FIELDS, HOST_NODE_FIELDS, IGNORED_NODE_FIELDS,
  MECHANICAL_PREDICATES, WORKFLOW_PREDICATES, PREDICATE_FIELDS,
  EFFORT_LEVELS, THINKING_LEVELS, MODEL_TIERS, AGENT_CONTEXTS, CALL_TRANSPORTS, CALL_RETRY_CLASSES, EFFECT_FAILURE_CODES, PROSE_ARTIFACT_TYPES,
} from "../vocabulary.js";
export type { WorkflowNodeKind, WorkflowPredicateName } from "../vocabulary.js";
