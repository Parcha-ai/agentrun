// Only the independent model boundary is scripted. Receipt pinning, cadence, checks, dry-run and commit are real. A test
// that sets globalThis.sdkCompilePrompts (or sdkRevisePrompts) to a list reads each compile (or revise) request's prompt there.
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
  // A held workflow's revise (its check held it: runner/learning-end.ts compileAskOf) answers a new revision of it.
  const revise = prompt.startsWith("One more turn: revise your learned workflow `release-status`");
  if (!revise && !prompt.startsWith("One more turn: write this agent")) throw new Error("Unexpected SDK model request.");
  (revise ? globalThis.sdkRevisePrompts : globalThis.sdkCompilePrompts)?.push(prompt);
  if (!prompt.includes("NO runNode") || !prompt.includes("mcp:backend/status") || !prompt.includes("ready")) throw new Error("The SDK compiler lost its callback capabilities or catalog.");
  const answer = revise ? { ...flow, root: { ...flow.root, deadline_s: 20 } } : flow;
  return faux.message("````workflow release-status\n---\ndescription: Check release readiness with existing backend tools.\nexample: {\"release\":\"current\"}\n---\n" + JSON.stringify(answer) + "\n````");
}
