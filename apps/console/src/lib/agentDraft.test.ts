import { describe, expect, it } from "vitest";
import { agentDraftHref, briefAgentDraft, parseAgentDraft, templateAgentDraft } from "./agentDraft";
import { TEMPLATES } from "./templates";

describe("agent build drafts", () => {
  it("carries a brief into an editable create request, through a reloadable fragment", () => {
    const draft = briefAgentDraft("  Read releases\nand flag security fixes.  ");
    const href = agentDraftHref(draft);
    expect(href.startsWith("#/playground?")).toBe(true);
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.get("operation")).toBe("create-agent");
    expect(parseAgentDraft(query.get("draft"))).toEqual(draft);
    expect(draft.definition.instructions).toBe("Read releases\nand flag security fixes.");
    expect(draft.definition.name).toBe("New agent");
  });
  it("copies the template's full definition without modifying the shared template", () => {
    const t = TEMPLATES.find((x) => x.id === "web")!;
    const before = JSON.stringify(t);
    const draft = templateAgentDraft(t, "Use British English.");
    expect(draft.definition).toEqual({ version: 1, name: t.name, description: t.description, instructions: `${t.instructions}\n\nAdditional requirements:\nUse British English.`, harness: "pi", tools: ["web_fetch"], skills: [] });
    draft.definition.tools.push("read");
    expect(JSON.stringify(t)).toBe(before);
  });
  it("rejects a malformed draft rather than handing off a partly copied definition", () => {
    for (const raw of [null, "{", "[]", "null", JSON.stringify({ definition: { instructions: "hello" } }), JSON.stringify({ definition: { ...briefAgentDraft("hi").definition, tools: [42] } })]) {
      expect(parseAgentDraft(raw)).toBeNull();
    }
  });
  it("only carries agent definition fields, never extra authentication settings", () => {
    const draft = briefAgentDraft("Write a report.");
    const incoming = { ...draft, token: "not-a-real-secret", definition: { ...draft.definition, api_key: "not-a-real-key" } };
    expect(parseAgentDraft(JSON.stringify(incoming))).toEqual(draft);
  });
});
