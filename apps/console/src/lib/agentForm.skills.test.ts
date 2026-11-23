import { SERVED_AGENT } from "@/test/agent";
import { describe, expect, it } from "vitest";
import { createBody, editBody, type Agent } from "./agentForm";

const files = {
  "reviewing/SKILL.md": "---\nname: reviewing\ndescription: Review a result.\n---\n\nCheck the evidence.\n",
  "reviewing/references/checklist.md": "Keep every evidence link.\n",
  "reviewing/scripts/check.sh": "#!/bin/sh\nprintf 'checked\\n'\n",
};
const agent: Agent = {
  ...SERVED_AGENT,
  agent_id: "reviewer", kind: "agentic", revision: "r2", revisions: 2, archived_at: null,
  definition: { version: 2, name: "Reviewer", instructions: "Review.", harness: "pi", skills: ["reviewing"], tools: [] },
};

describe("agent skill revision bodies", () => {
  it("sends a complete edited skill bundle beside its definition, preserving support files", () => {
    const skillFiles = { ...files, "reviewing/SKILL.md": `${files["reviewing/SKILL.md"]}\nExplain every finding.\n` };
    const body = editBody(agent, { skillFiles }, "Updated review guidance", files);
    expect(body).toEqual({ definition: { ...agent.definition, version: 3 }, note: "Updated review guidance", skills: skillFiles, unchanged: false });
    expect(body.definition).not.toHaveProperty("skillFiles");
    expect(files["reviewing/SKILL.md"]).not.toContain("Explain every finding.");
  });

  it("derives skill names from SKILL.md files when adding another bundle", () => {
    const skillFiles = { ...files, "reporting/SKILL.md": "---\nname: reporting\ndescription: Write a report.\n---\n\nSummarize the result.\n" };
    const body = editBody(agent, { skillFiles }, "", files);
    expect(body).toMatchObject({ definition: { version: 3, skills: ["reporting", "reviewing"] }, skills: skillFiles, unchanged: false });
    expect(body.definition).not.toHaveProperty("skillFiles");
  });

  it("treats the original file contents as unchanged, independent of map order", () => {
    const skillFiles = Object.fromEntries(Object.entries(files).reverse());
    const body = editBody(agent, { skillFiles }, "A note alone", files);
    expect(body.unchanged).toBe(true);
    expect(body.definition.version).toBe(2);
    expect(body.definition.skills).toEqual(["reviewing"]);
    expect(body.definition).not.toHaveProperty("skillFiles");
    expect(editBody(agent, { instructions: "Review twice." }, "")).not.toHaveProperty("skills");
  });

  it("creates an agent with its skill files and the corresponding skill names", () => {
    const body = createBody({ name: "Reviewer", description: "", instructions: "Review.", harness: "pi", tools: [], skillFiles: files });
    expect(body).toMatchObject({ definition: { version: 1, name: "Reviewer", skills: ["reviewing"] }, skills: files });
    expect(body.definition).not.toHaveProperty("skillFiles");
  });
});
