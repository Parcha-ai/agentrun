// The language's closed vocabulary. The validator admits exactly these kinds, fields and predicates,
// and the author contract names them from the same constants, so the two cannot drift.

export const WORKFLOW_NODE_KINDS = [
  "chain", "code", "agent", "decide", "extract", "report", "artifact", "map", "parallel", "loop",
  "escalate", "call", "workflow", "judge", "pick", "sift", "route",
] as const;
export type WorkflowNodeKind = typeof WORKFLOW_NODE_KINDS[number];

/** Generative kinds: one adapter session each, answering against a schema. */
export const GENERATIVE_NODE_KINDS = ["agent", "decide", "extract", "report"] as const satisfies readonly WorkflowNodeKind[];
/** Typed-question kinds: one judge request each, no tools and no session. */
export const JUDGMENT_NODE_KINDS = ["judge", "pick", "sift", "route"] as const satisfies readonly WorkflowNodeKind[];

const GENERATIVE_FIELDS = ["node", "label", "state", "instructions", "sopSection", "out", "as", "requires", "tools", "effort", "thinking", "verify", "tier"] as const;

/** The fields each node kind accepts. Any other key is an authoring error. */
export const NODE_FIELDS: { readonly [Kind in WorkflowNodeKind]: readonly string[] } = {
  chain: ["node", "steps"],
  code: ["node", "label", "code", "as"],
  agent: GENERATIVE_FIELDS,
  decide: GENERATIVE_FIELDS,
  extract: GENERATIVE_FIELDS,
  report: ["node", "label", "state", "instructions", "sopSection", "requires", "tools", "effort", "thinking"],
  artifact: ["node", "label", "state", "type", "path", "instructions", "sopSection", "requires", "tools", "effort", "thinking"],
  map: ["node", "label", "itemsPath", "body", "as", "resultPath", "maxConcurrency"],
  parallel: ["node", "label", "branches"],
  loop: ["node", "label", "body", "until", "maxIters"],
  escalate: ["node", "label", "when", "kind", "stage", "summary"],
  call: ["node", "label", "via", "tool", "args", "code", "input", "command", "env", "where", "out", "as", "produces", "deadline_s", "retry", "poll", "requires"],
  workflow: ["node", "label", "workflow", "input", "out", "as"],
  judge: ["node", "label", "state", "out", "as", "requires"],
  pick: ["node", "label", "itemsPath", "describe", "instructions", "state", "allowNone", "as", "requires"],
  sift: ["node", "label", "itemsPath", "describe", "state", "out", "as", "keep", "requires"],
  route: ["node", "label", "state", "instructions", "branches", "unsure", "as", "requires"],
};

/** Fields every node kind accepts in addition to its own. `metadata` is the host's: an optional object of
 *  host markers the engine admits, carries and hashes with the document, and never reads. */
export const HOST_NODE_FIELDS = ["metadata"] as const;

/** Accepted and ignored for older v2 documents; never taught. The engine invokes the adapter once per node. */
export const IGNORED_NODE_FIELDS: { readonly [Kind in WorkflowNodeKind]?: readonly string[] } = {
  agent: ["budget"],
  decide: ["samples", "voteField"],
};

/** Predicates that read a state value. `poll` accepts only these. */
export const MECHANICAL_PREDICATES = ["field_equals", "field_true", "in", "count_gte", "gte", "lt", "empty", "no_new_items"] as const;
/** Every predicate `loop.until` and `escalate.when` accept: the mechanical set plus `ask`, a yes/no judge question. */
export const WORKFLOW_PREDICATES = [...MECHANICAL_PREDICATES, "ask"] as const;
export type WorkflowPredicateName = typeof WORKFLOW_PREDICATES[number];

/** The fields each predicate takes. */
export const PREDICATE_FIELDS: { readonly [Name in WorkflowPredicateName]: readonly string[] } = {
  field_equals: ["path", "value"],
  field_true: ["path"],
  in: ["path", "values"],
  count_gte: ["path", "n"],
  gte: ["path", "n"],
  lt: ["path", "n"],
  empty: ["path"],
  no_new_items: ["key"],
  ask: ["instructions", "state", "criteria", "gte"],
};

export const EFFORT_LEVELS = ["minimal", "low", "medium", "high"] as const;
/** There is no "off": every generative node thinks. */
export const THINKING_LEVELS = ["low", "medium", "high"] as const;
export const MODEL_TIERS = ["fast", "default", "strong"] as const;
export const CALL_TRANSPORTS = ["tool", "executor", "shell"] as const;
export const CALL_RETRY_CLASSES = ["timeout", "http_5xx", "http_429", "connection", "exit"] as const;
/** Artifact types the engine itself treats as prose (the report writer). Every other type names a file. */
export const PROSE_ARTIFACT_TYPES = ["markdown", "report"] as const;
