// Made-up workflow drafts, as a compile turn gives them, and a run's changes to the learning folder.

export const RUN = "2026-10-27-0412-a1b2";

/** A new file of the run's, as the host hands it to the checker. */
export const added = (path, text, extra = {}) => ({ path, status: "added", mode: "100644", bytes: Buffer.from(text), ...extra });

/** A workflow draft with one model node; `tools` are the tools it names. */
export const workflow = ({ name = "find-policies", tools = [], node = "agent" } = {}) => JSON.stringify({
  v: 2,
  name,
  schemas: { Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Policies: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } },
  input: { schemaId: "Store" },
  output: { schemaId: "Policies", path: "policies" },
  root: { node, label: "find", instructions: "Find the store's refund policy from its public pages.", out: "Policies", as: "policies", tools },
}, null, 2);

/** A draft with a model node, a call node on `tool`, a fast-tier model node that reads the page into compact facts and
 *  a model node that answers from those facts alone (compact state); with `judge`, a judge node in the last one's place
 *  (which a learned workflow cannot run); with `code`, a code node in the first model node's place. */
export const richWorkflow = ({ tool = "web_fetch", code, judge = false } = {}) => JSON.stringify({
  v: 2,
  name: "find-policies",
  schemas: {
    Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    Target: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    Page: { type: "object" },
    Facts: { type: "object", properties: { policy_lines: { type: "array", items: { type: "string" } } }, required: ["policy_lines"] },
    Verdict: { type: "object", properties: { states_refunds: { type: "boolean", description: "Does the page state the store's refund policy?" } }, required: ["states_refunds"] },
  },
  input: { schemaId: "Store" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "chain", steps: [
    code === undefined
      ? { node: "extract", label: "prep", instructions: "Name the path where this store keeps its policies.", out: "Target", as: "target", tools: [] }
      : { node: "code", label: "prep", code },
    { node: "call", label: "fetch", via: "tool", tool, args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 },
    { node: "extract", label: "facts", instructions: "Copy the lines of the page that state the store's refund policy.", state: { page: "{page}" }, out: "Facts", as: "facts", tools: [], tier: "fast" },
    judge
      ? { node: "judge", label: "refund", state: { page: "{page}" }, out: "Verdict", as: "verdict" }
      : { node: "extract", label: "refund", instructions: "Say whether the policy lines state the store's refund policy.", state: { facts: "{facts}" }, out: "Verdict", as: "verdict", tools: [] },
  ] },
}, null, 2);

/** A workflow draft's README, as the host writes it from the description its block gives. */
export const readme = "---\nname: find-policies\ndescription: Finds a store's refund policy; use it when a case asks what a store's refunds are\n---\n";

/** Where a compile turn's workflow draft lands, in the folder. */
export const DRAFT_PATH = "workflows/find-policies/workflow.json";
export const README_PATH = "workflows/find-policies/README.md";
