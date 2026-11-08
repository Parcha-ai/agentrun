// A faux model for the code-review package's agent: when the review skill is in its system prompt, it answers as the
// skill's step 7 says, a short line and then one fenced json block of findings; otherwise it says the skill is missing.
const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");

export const FINDINGS = {
  head_sha: "1f0c6a3d2b9e8f7a6c5d4e3b2a1908f7e6d5c4b3",
  summary: "The change drops the guard for an unknown id. One defect: displayName throws for an id no user has.",
  findings: [{ path: "src/users.js", line: 3, severity: "important", category: "bug", claim: "For an id no user has, users.find returns undefined and user.name throws (src/users.js:3); before, it answered \"unknown\".", fingerprint: "src/users.js:displayname:null-deref", confidence: 0.9 }],
  resolve: [],
};

export default function reply(context, faux) {
  const system = [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].join("\n");
  if (!system.includes('<skill name="review">') || !system.includes("**Return** exactly one fenced `json` block")) return faux.message("The review skill was not in my prompt.");
  return faux.message(`Reviewed the change.\n\n\`\`\`json\n${JSON.stringify(FINDINGS, null, 2)}\n\`\`\``);
}
