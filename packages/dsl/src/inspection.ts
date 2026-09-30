import { workflowDocumentError, workflowSha256, type Workflow, type WorkflowNode } from "./workflow.js";
import { workflowShapeErrors } from "./workflow-shape.js";

export type WorkflowInspectionNode = {
  path: string;
  parent?: string;
  relation: string;
  kind: WorkflowNode["node"];
  label: string;
  workflow: string;
  writes?: string;
  outputSchema?: string;
  /** Effective selection from completed map-item state; absent means whole item state. */
  resultPath?: string;
  childWorkflow?: string;
};

export type WorkflowInspection = {
  name: string;
  version: 2;
  sha256: string;
  checked: "structure-only";
  inputSchema?: string;
  outputSchema: string;
  outputPath?: string;
  nodes: WorkflowInspectionNode[];
  requires: {
    adapters: ("runNode" | "runJudge" | "runEffect")[];
    tools: string[];
    sopSections: string[];
    executableCode: boolean;
  };
};

const pointer = (part: string): string => part.replace(/~/g, "~0").replace(/\//g, "~1");

/** Inspect a workflow's structure without running authored code, adapters, or schema probes.
 * The input must be plain JSON data. This is a review aid, not execution admission: use
 * validateWorkflow on trusted documents and the host's own capability gate before running. */
export function inspectWorkflow(value: unknown): WorkflowInspection {
  const bound = workflowDocumentError(value);
  if (bound) throw new Error(`Cannot inspect workflow: ${bound}`);
  const errors = workflowShapeErrors(value, true);
  if (errors.length) throw new Error(`Cannot inspect workflow: ${errors.join("; ")}`);
  const workflow = value as Workflow;
  const nodes: WorkflowInspectionNode[] = [];
  const adapters = new Set<"runNode" | "runJudge" | "runEffect">();
  const tools = new Set<string>();
  const sopSections = new Set<string>();
  let executableCode = false;

  const visit = (node: WorkflowNode, owner: Workflow, path: string, relation: string, parent?: string): void => {
    nodes.push({ path, ...(parent ? { parent } : {}), relation, kind: node.node,
      label: "label" in node ? node.label : node.node, workflow: owner.name,
      ...("as" in node && node.as ? { writes: node.as }
        : ["agent", "extract", "decide"].includes(node.node) && "label" in node ? { writes: node.label }
        : node.node === "report" ? { writes: "report_markdown" } : {}),
      ...("out" in node && node.out && node.node !== "sift" ? { outputSchema: node.out } : {}),
      ...(node.node === "map" && (node.resultPath || "as" in node.body && node.body.as)
        ? { resultPath: node.resultPath || (node.body as { as: string }).as } : {}),
      ...(node.node === "workflow" ? { childWorkflow: node.workflow.name } : {}),
    });
    if (["agent", "decide", "extract", "report"].includes(node.node) ||
      node.node === "artifact" && ["markdown", "report"].includes(node.type)) adapters.add("runNode");
    if (["judge", "pick", "sift", "route"].includes(node.node) ||
      "verify" in node && node.verify || node.node === "loop" && node.until.predicate === "ask" ||
      node.node === "escalate" && node.when.predicate === "ask") adapters.add("runJudge");
    if (node.node === "call") {
      adapters.add("runEffect");
      if (node.via === "tool" && node.tool) tools.add(node.tool);
      if (node.via === "shell" || node.via === "executor") executableCode = true;
    }
    if (node.node === "code") executableCode = true;
    if ("tools" in node) node.tools?.forEach(tool => tools.add(tool));
    if ("sopSection" in node && node.sopSection) {
      const sections = Array.isArray(node.sopSection) ? node.sopSection : [node.sopSection];
      sections.forEach(section => sopSections.add(section));
    }
    switch (node.node) {
      case "chain": node.steps.forEach((step, index) => visit(step, owner, `${path}/steps/${index}`, `step ${index + 1}`, path)); break;
      case "parallel": node.branches.forEach((branch, index) => visit(branch, owner, `${path}/branches/${index}`, `parallel ${index + 1}`, path)); break;
      case "map": visit(node.body, owner, `${path}/body`, `each ${node.itemsPath}`, path); break;
      case "loop": visit(node.body, owner, `${path}/body`, `up to ${node.maxIters} iterations`, path); break;
      case "dispatch": case "route": Object.entries(node.branches).forEach(([name, branch]) =>
        visit(branch.body, owner, `${path}/branches/${pointer(name)}/body`, `${node.node} ${name}`, path)); break;
      case "workflow": visit(node.workflow.root, node.workflow, `${path}/workflow/root`, `workflow ${node.workflow.name}`, path); break;
    }
  };
  visit(workflow.root, workflow, "/root", "root");
  return {
    name: workflow.name, version: workflow.v, sha256: workflowSha256(workflow), checked: "structure-only",
    ...(workflow.input ? { inputSchema: workflow.input.schemaId } : {}), outputSchema: workflow.output.schemaId,
    ...(workflow.output.path ? { outputPath: workflow.output.path } : {}),
    nodes, requires: { adapters: [...adapters].sort(), tools: [...tools].sort(), sopSections: [...sopSections].sort(), executableCode },
  };
}

export function formatWorkflowTree(inspection: WorkflowInspection): string {
  const safe = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const children = new Map<string | undefined, WorkflowInspectionNode[]>();
  for (const node of inspection.nodes) {
    const list = children.get(node.parent) ?? [];
    list.push(node); children.set(node.parent, list);
  }
  const lines = [`${safe(inspection.name)} (${inspection.inputSchema ? safe(inspection.inputSchema) : "input"} → ${safe(inspection.outputSchema)})`];
  const visit = (parent: string | undefined, prefix: string): void => {
    const list = children.get(parent) ?? [];
    list.forEach((node, index) => {
      const last = index === list.length - 1;
      const relation = /^(parallel |each |up to |route |dispatch |workflow )/.test(node.relation) ? `${safe(node.relation)}: ` : "";
      const value = node.outputSchema ? ` (${safe(node.outputSchema)})` : node.kind === "map"
        ? ` (array; ${node.resultPath ? `select ${safe(node.resultPath)}` : "whole item state"})`
        : node.kind === "code" ? " (returned value)" : "";
      lines.push(`${prefix}${last ? "└─" : "├─"} ${relation}${safe(node.label)} [${node.kind}]${node.writes ? ` → ${safe(node.writes)}${value}` : node.kind === "code" ? " → state patch (object) or label (non-object)" : ""}`);
      visit(node.path, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  visit(undefined, "");
  lines.push(`Final output: ${inspection.outputPath ? safe(inspection.outputPath) : "whole state"} (${safe(inspection.outputSchema)})`);
  lines.push(`Adapters: ${inspection.requires.adapters.join(", ") || "none"}`);
  lines.push("Graph preview — shows structure, not execution results.");
  return lines.join("\n");
}
