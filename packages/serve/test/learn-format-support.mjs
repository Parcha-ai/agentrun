// Made-up notes in Claude Code's auto-memory format, a folder of them, and a run's changes to it.
import { parseNoteFile } from "../dist/learn/notes.js";

export const RUN = "2026-10-27-0412-a1b2";

/** A note's file: front matter with `name`, `description` and `type`, any `extra` lines, then the body. */
export const note = ({ name = "Refund policy path", description = "Shopify stores keep their policies at /policies/", type = "reference", extra = "", body = "Open /policies/ before searching the store.\n" } = {}) =>
  `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n${extra}---\n${body}`;

/** The seed a run started from: two active notes, one superseded, and the index. */
export const SEED = {
  "MEMORY.md": "- [Prefers tables](prefers-tables.md) — The user reads results as tables\n- [Shipping path](shipping-path.md) — Shipping lives under /policies/ too\n",
  "prefers-tables.md": note({ name: "Prefers tables", description: "The user reads results as tables", type: "user" }),
  "shipping-path.md": note({ name: "Shipping path", description: "Shipping lives under /policies/ too" }),
  "old-refunds.md": note({ name: "Old refunds", description: "Refunds were under /help/", extra: "status: superseded\nsuperseded_by: shipping-path.md\n" }),
};

/** A folder's base, as the checker reads it: every path, and its active notes. */
export const baseOf = (files = SEED) => ({
  files: Object.keys(files),
  active: Object.entries(files).flatMap(([file, text]) => {
    const parsed = file === "MEMORY.md" ? [] : parseNoteFile(file, text);
    return Array.isArray(parsed) || parsed.status !== "active" ? [] : [parsed];
  }),
});

/** A new file of the run's, as the host hands it to the checker. */
export const added = (path, text, extra = {}) => ({ path, status: "added", mode: "100644", bytes: Buffer.from(text), ...extra });

/** A skill's SKILL.md: front matter with `name` (its folder's) and `description`, then how to do the job. */
export const skill = ({ name = "find-policies", description = "Find a store's refund and shipping policies" } = {}) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Find policies\n\nOpen /policies/ first, then the footer links.\n`;

/** A workflow draft with one model node; `tools` are the tools it names. */
export const workflow = ({ name = "find-policies", tools = ["web_fetch"], node = "agent" } = {}) => JSON.stringify({
  v: 2,
  name,
  schemas: { Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Policies: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } },
  input: { schemaId: "Store" },
  output: { schemaId: "Policies", path: "policies" },
  root: { node, label: "find", instructions: "Find the store's refund policy from its public pages.", out: "Policies", as: "policies", tools },
}, null, 2);

/** A draft with a model node, a call node on `tool` and a judge node; with `code`, a code node in the model node's place. */
export const richWorkflow = ({ tool = "web_fetch", code } = {}) => JSON.stringify({
  v: 2,
  name: "find-policies",
  schemas: {
    Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    Target: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    Page: { type: "object" },
    Verdict: { type: "object", properties: { states_refunds: { type: "boolean", description: "Does the page state the store's refund policy?" } }, required: ["states_refunds"] },
  },
  input: { schemaId: "Store" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "chain", steps: [
    code === undefined
      ? { node: "extract", label: "prep", instructions: "Name the path where this store keeps its policies.", out: "Target", as: "target", tools: [] }
      : { node: "code", label: "prep", code },
    { node: "call", label: "fetch", via: "tool", tool, args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 },
    { node: "judge", label: "refund", state: { page: "{page}" }, out: "Verdict", as: "verdict" },
  ] },
}, null, 2);

/** A workflow draft's README. */
export const readme = "# find-policies\n\nFinds a store's refund policy. Use it when a case asks what a store's refunds are.\n";

/** Where a run proposes a skill and a workflow draft, in the folder. */
export const SKILL_PATH = "skills/find-policies/SKILL.md";
export const DRAFT_PATH = "workflows/find-policies/workflow.json";
export const README_PATH = "workflows/find-policies/README.md";
