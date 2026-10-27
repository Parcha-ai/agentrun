// Made-up runs, notes and drafts: a clean run's branch, and helpers to change one file of it.
import { checkRun } from "../dist/index.js";

export const RUN = "2026-10-27-0412-a1b2";
export const BRANCH = `runs/${RUN}`;
export const FORK = "3f9c2e1a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e";
export const NOTE_ID = "L-7c21e0a4b9d3";
export const OLD_NOTE = "L-0a93ff12c4e7";

export const memo = ({ run = RUN, base = FORK.slice(0, 7), outcome = "completed", extra = "", proposed = ["learnings/L-7c21e0a4b9d3.md (new)", ".agents/skills/find-policies/ (new)", "workflows/find-policies/ (new draft)"] } = {}) => `---
run: ${run}
base: ${base}            # the commit of main the run read
harness: codex
outcome: ${outcome}
cost_usd: 0.42
---
## What happened
Looked up the refund policy of a store and found it on the third try.

## What I learned
- New note learnings/L-7c21e0a4b9d3.md: Shopify stores keep their policies at /policies/.
${extra}
## What could be better
- I read 9 pages to find the refund policy; the footer links would have taken 2.

## Proposed changes
${proposed.map((line) => `- ${line}`).join("\n")}
`;

export const note = ({ id = NOTE_ID, type = "lesson", status = "active", runs = `[${RUN}]`, supersedes = "[]", body = "Shopify stores keep their policies at /policies/; try that path before searching." } = {}) =>
  `---\nid: ${id}\ntype: ${type}\nstatus: ${status}\nruns: ${runs}\nsupersedes: ${supersedes}\n---\n${body}\n`;

/** A note as the Pi learning loop writes it: its own fields, runs under provenance. */
export const piNote = (id = NOTE_ID, runs = [RUN]) => [
  "---", `id: ${id}`, "type: fact", "scope: all", "status: active", "provenance:", `  runs: ${JSON.stringify(runs)}`, `  sha: ${FORK}`, "  untrusted: false", "uses: 2", "supersedes: []", "---",
  "Order numbers in the store's admin start with a hash sign.", "",
].join("\n");

export const index = (ids = [NOTE_ID]) => `# Learnings\n\n${ids.map((id) => `- ${id}: Shopify stores keep their policies at /policies/.`).join("\n")}\n`;

export const skill = ({ name = "find-policies", description = "Find a store's refund and shipping policies." } = {}) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# Find policies\n\nTry /policies/ first, then the footer links.\n`;

export const workflow = ({ name = "find-policies", tools = ["fetch_page"], node = "agent" } = {}) => JSON.stringify({
  v: 2,
  name,
  schemas: { Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Policies: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } },
  input: { schemaId: "Store" },
  output: { schemaId: "Policies", path: "policies" },
  root: { node, label: "find", instructions: "Find the store's refund policy from its public pages.", out: "Policies", as: "policies", tools },
}, null, 2);

export const readme = "# find-policies\n\nFinds a store's refund policy. Use it when a case asks what a store's refunds are.\n";

/** The clean branch: a memo, one new note, the index, a skill and a workflow draft. */
export function cleanFiles() {
  return {
    [`memos/${RUN}.md`]: memo(),
    [`learnings/${NOTE_ID}.md`]: note(),
    "learnings/INDEX.md": index(),
    ".agents/skills/find-policies/SKILL.md": skill(),
    "workflows/find-policies/workflow.json": workflow(),
    "workflows/find-policies/README.md": readme,
  };
}

/** The files on main the branch starts from. */
export const MAIN_FILES = ["AGENTS.md", "agent.json", "learnings/INDEX.md", `learnings/${OLD_NOTE}.md`];

/** Checks `files` (path to text, Buffer, or null for a deletion) as the run's changes on `branch`. A path on main is
 *  `modified`, any other `added`. `mode` gives a path's git mode. */
export function check(files, { branch = BRANCH, forkPoint = FORK, main = MAIN_FILES, mode = {}, ...rest } = {}) {
  const changes = Object.entries(files).map(([path, text]) => ({
    path,
    status: text === null ? "deleted" : main.includes(path) ? "modified" : "added",
    ...(mode[path] ? { mode: mode[path] } : {}),
    ...(text === null ? {} : { bytes: typeof text === "string" ? Buffer.from(text, "utf8") : text }),
  }));
  const head = new Set([...main, ...Object.keys(files)]);
  for (const [path, text] of Object.entries(files)) if (text === null) head.delete(path);
  return checkRun({ branch, changes, forkPoint, headFiles: head, ...rest });
}

/** The rules a check reported, sorted, each once. */
export const rules = (problems) => [...new Set(problems.map((p) => p.rule))].sort();
