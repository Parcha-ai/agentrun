import type { Template } from "./templates";

/** An editable create request, containing only agent configuration. No session or credential is carried between pages. */
export type AgentCreateDraft = {
  definition: {
    version: 1;
    name: string;
    description?: string;
    instructions: string;
    harness: "pi";
    tools: string[];
    skills: [];
  };
};

export function briefAgentDraft(brief: string): AgentCreateDraft {
  return { definition: { version: 1, name: "New agent", instructions: brief.trim(), harness: "pi", tools: [], skills: [] } };
}

export function templateAgentDraft(template: Template, brief = ""): AgentCreateDraft {
  const extra = brief.trim();
  return { definition: {
    version: 1, name: template.name, description: template.description,
    instructions: template.instructions + (extra ? `\n\nAdditional requirements:\n${extra}` : ""),
    harness: "pi", tools: [...template.tools], skills: [],
  } };
}

/** The draft stays in the URL fragment, so it survives a reload and is never sent to the server as a URL query. */
export function agentDraftHref(draft: AgentCreateDraft): string {
  return `#/playground?${new URLSearchParams({ operation: "create-agent", draft: JSON.stringify(draft) })}`;
}

/** A malformed handoff is not replaced with a partly copied definition. The Playground can show its normal editor. */
export function parseAgentDraft(raw: string | null | undefined): AgentCreateDraft | null {
  if (!raw) return null;
  try {
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || !("definition" in body)) return null;
    const d = body.definition;
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    const v = d as Record<string, unknown>;
    if (v.version !== 1 || typeof v.name !== "string" || typeof v.instructions !== "string" || v.harness !== "pi"
      || (v.description !== undefined && typeof v.description !== "string")
      || !Array.isArray(v.tools) || !v.tools.every((tool) => typeof tool === "string")
      || !Array.isArray(v.skills) || v.skills.length !== 0) return null;
    return { definition: {
      version: 1, name: v.name, instructions: v.instructions, harness: "pi", tools: [...v.tools], skills: [],
      ...(typeof v.description === "string" ? { description: v.description } : {}),
    } };
  } catch { return null; }
}
