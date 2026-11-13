// The workflow adapters this host gives every run: model nodes, and calls `via: "tool"` to the table's tools. Typed
// questions (`runJudge`) run too where the host sets a decision provider's key (decisions.ts). On the runner side so the
// run path and the workflow loop read it from one place; what a save and capabilities report stays the same list.
export const WORKFLOW_ADAPTERS = ["runNode", "runEffect"] as const;
