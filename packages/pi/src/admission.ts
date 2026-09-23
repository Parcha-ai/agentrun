
export interface WorkflowAdmissionOptions {
  rubricSections?: Record<string, string>;
  allowExecutableCandidates?: boolean;
  allowedEffectTools?: readonly string[];
}
export function workflowPolicyErrors(candidate: unknown, options: WorkflowAdmissionOptions): string[] {
  const errors: string[] = [];
  const sections = Object.keys(options.rubricSections ?? {});
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const visit = (value: unknown) => {
    const node = record(value);
    if (!node) return;
    const kind = node.node;
    if (!options.allowExecutableCandidates && ["code", "call", "artifact"].includes(String(kind)) && !(kind === "call" && node.via === "tool" && typeof node.tool === "string" && options.allowedEffectTools?.includes(node.tool))) errors.push(`${kind} requires allowExecutableCandidates`);
    if (sections.length && ["judge", "pick", "sift", "route"].includes(String(kind))) errors.push(`${String(kind)} cannot carry supplied SOP sections; use an LLM node with sopSection`);
    const llm = ["agent", "decide", "extract", "report"].includes(String(kind));
    const predicate = kind === "loop" ? record(node.until) : kind === "escalate" ? record(node.when) : undefined;
    if (sections.length && (predicate?.predicate === "ask" || (llm && node.verify !== undefined))) errors.push("Semantic predicates and verify clauses require a separately reviewed question contract when rubric sections are supplied");
    const proseArtifact = kind === "artifact" && (node.type === "markdown" || node.type === "report");
    if (llm || proseArtifact) {
      const included = Array.isArray(node.sopSection) ? node.sopSection : [node.sopSection];
      for (const section of sections) if (!included.includes(section)) errors.push(`${String(node.label)} must include rubric section ${section}`);
    }

    switch (kind) {
      case "chain": if (Array.isArray(node.steps)) node.steps.forEach(visit); break;
      case "parallel": if (Array.isArray(node.branches)) node.branches.forEach(visit); break;
      case "map": case "loop": visit(node.body); break;
      case "route": {
        const branches = record(node.branches);
        if (branches) Object.values(branches).forEach(branch => visit(record(branch)?.body));
        break;
      }
      case "workflow": visit(record(node.workflow)?.root); break;
    }
  };
  visit(record(candidate)?.root);
  return errors;
}

