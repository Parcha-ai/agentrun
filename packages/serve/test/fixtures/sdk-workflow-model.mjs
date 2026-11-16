// Only the independent model boundary is scripted. Receipt pinning, cadence, checks, dry-run, grading and commit are real.
const skill = "---\nname: release-status\ndescription: Check release readiness with the backend status tool.\n---\nFor every release-status request, call mcp:backend/status with its release input and return the tool's ready boolean as JSON.\n";
const flow = { v: 2, name: "release-status", schemas: {
  Input: { type: "object", properties: { release: { type: "string" } }, required: ["release"] },
  Status: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] },
}, input: { schemaId: "Input" }, output: { schemaId: "Status", path: "status" }, root: {
  node: "call", label: "status", via: "tool", tool: "mcp:backend/status", args: { release: "{release}" }, out: "Status", as: "status", deadline_s: 10,
} };
export default function reply(context, faux) {
  const prompt = context.messages.map((message) => typeof message.content === "string" ? message.content : (message.content?.map((part) => part.text ?? "").join("") ?? "")).join("\n");
  if (prompt.startsWith("The task is done.")) {
    const evidence = JSON.parse(prompt.split("<run_evidence>\n")[1].split("\n</run_evidence>")[0]);
    if (evidence.user_input.startsWith("Teach release status")) return faux.message("````skill release-status\n" + skill + "````");
    if (!evidence.supplied_skills.some((entry) => entry.name === "release-status" && entry.files["SKILL.md"] === skill)) throw new Error("The SDK reflection lost the supplied skill body.");

    return faux.message("No notes.");
  }
  if (prompt.startsWith("One more turn: write this agent")) {
    if (!prompt.includes("NO runNode") || !prompt.includes("mcp:backend/status") || !prompt.includes("ready")) throw new Error("The SDK compiler lost its callback capabilities or catalog.");
    return faux.message("````workflow release-status\n---\ndescription: Check release readiness with existing backend tools.\nexample: {\"release\":\"current\"}\n---\n" + JSON.stringify(flow) + "\n````");
  }
  const file = /Give one item for each of these files, each once, and for no other: ([^\n]+)\./.exec(prompt)?.[1];
  if (!file || !["skills/release-status/SKILL.md", "workflows/release-status/workflow.json"].includes(file)) throw new Error("Unexpected SDK workflow grading input.");
  return faux.message(JSON.stringify({ merge: true, reason: "A reusable requested procedure using existing tools.", items: [{ file, general: true, decision: "keep", origin: "you", why: "The reusable procedure preserves the source task policy and output." }] }));
}
