// Only the independent model boundary is scripted. Receipt pinning, cadence, checks, dry-run, grading and commit are real.
const flow = { v: 2, name: "release-status", schemas: {
  Input: { type: "object", properties: { release: { type: "string" } }, required: ["release"] },
  Status: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] },
}, input: { schemaId: "Input" }, output: { schemaId: "Status", path: "status" }, root: {
  node: "call", label: "status", via: "tool", tool: "mcp:backend/status", args: { release: "{release}" }, out: "Status", as: "status", deadline_s: 10,
} };
export default function reply(context, faux) {
  const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : (message.content?.map((part) => part.text ?? "").join("") ?? "")).join("\n");
  // An SDK task carries no owner feedback: a run of a workflow job is never asked its look-back.
  if (prompt.startsWith("The task is done.")) throw new Error("An SDK run of a workflow job was asked its look-back.");
  if (prompt.startsWith("One more turn: write this agent")) {
    if (!prompt.includes("NO runNode") || !prompt.includes("mcp:backend/status") || !prompt.includes("ready")) throw new Error("The SDK compiler lost its callback capabilities or catalog.");
    return faux.message("````workflow release-status\n---\ndescription: Check release readiness with existing backend tools.\nexample: {\"release\":\"current\"}\n---\n" + JSON.stringify(flow) + "\n````");
  }
  const file = /Give one item for each of these files, each once, and for no other: ([^\n]+)\./.exec(prompt)?.[1];
  if (file !== "workflows/release-status/workflow.json") throw new Error("Unexpected SDK workflow grading input.");
  return faux.message(JSON.stringify({ merge: true, reason: "A reusable requested procedure using existing tools.", items: [{ file, general: true, decision: "keep", origin: "you", why: "The reusable procedure preserves the source task policy and output." }] }));
}
