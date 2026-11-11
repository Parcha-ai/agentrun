// A faux model for the code-review package's agent: when the review skill is in its system prompt, it answers as the
// skill's step 8 says, a short line and then one fenced json block of findings; otherwise it says the skill is missing.
const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");

export const FINDINGS = {
  head_sha: "1f0c6a3d2b9e8f7a6c5d4e3b2a1908f7e6d5c4b3",
  summary: "The change drops the guard for an unknown id. One defect: displayName throws for an id no user has.",
  risk_score: 3,
  risk_reasons: ["displayName throws a TypeError for any id that no user has"],
  findings: [{ priority: "P1", title: "Unknown id crashes displayName", path: "src/users.js", line: 3, category: "bug", failure: "For an id no user has, users.find returns undefined and user.name throws (src/users.js:3); before, it answered \"unknown\".", fingerprint: "src/users.js:displayname:null-deref", confidence: 0.9 }],
  coverage: [{ path: "src/users.js", hunks: "1-4", verdict: "guard for an unknown id removed → candidate proven" }],
  dropped: [],
  resolve: [],
};

export default function reply(context, faux) {
  const system = [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].join("\n");
  const read = context.messages.filter((m) => m.role === "toolResult").map((m) => textOf(m.content)).join("\n");
  // A run that reads files gets the skill as a line naming its SKILL.md (skills.ts, on demand) and reads it first, as a
  // model following that line does; a run that cannot gets it inlined.
  // (`read` answers a long file a page at a time: the skill's own front matter, on its first page, says it was read.)
  const listed = /^- review: .*\((\S+\/review\/SKILL\.md)\)$/m.exec(system);
  if (listed && !read.includes("name: review\ndescription: Review a pull request")) return faux.message(faux.toolCall("read", { path: listed[1] }), { stopReason: "toolUse" });
  const inlined = system.includes('<skill name="review">') && system.includes("**Return** exactly one fenced `json` block");
  if (!inlined && !listed) return faux.message("The review skill was not in my prompt.");
  return faux.message(`Reviewed the change.\n\n\`\`\`json\n${JSON.stringify(FINDINGS, null, 2)}\n\`\`\``);
}
