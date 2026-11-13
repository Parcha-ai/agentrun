// The backend's explicitly delegated tool catalog. No connection URLs, credentials, or callbacks cross this boundary.
import { LEARNED_MCP_TOOL } from "../learn/skills.js";
import { ApiError } from "../errors.js";
import { isObject } from "../store/agent-body.js";

export type SdkWorkflowAdapter = "runNode" | "runJudge";
export type SdkWorkflowTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  permission: "allow" | "ask" | "deny";
  price_usd?: number;
};
const invalid = (message: string): never => { throw new ApiError("input_invalid", message); };
export function sdkWorkflowManifest(tools: unknown, adapters: unknown): { workflow_tools: SdkWorkflowTool[]; workflow_adapters: SdkWorkflowAdapter[] } | undefined {
  if (tools === undefined) {
    if (adapters !== undefined) invalid("workflow_adapters requires workflow_tools.");
    return undefined;
  }
  if (!Array.isArray(tools) || tools.length > 64 || Buffer.byteLength(JSON.stringify(tools)) > 65_536)
    return invalid("workflow_tools must contain at most 64 tools and 64 KiB of JSON.");
  const names = new Set<string>();
  const manifest = tools.map((tool): SdkWorkflowTool => {
    if (!isObject(tool) || Object.keys(tool).some((key) => !["name", "description", "input_schema", "output_schema", "permission", "price_usd"].includes(key)))
      return invalid("Each workflow tool must be a manifest entry with no credentials or connection settings.");
    if (typeof tool.name !== "string" || tool.name.length > 256 || !LEARNED_MCP_TOOL.test(tool.name) || names.has(tool.name))
      return invalid("Workflow tool names must be unique canonical mcp:server/tool names, without wildcards.");
    names.add(tool.name);
    if (typeof tool.description !== "string" || !tool.description.trim() || tool.description.length > 4000 || !isObject(tool.input_schema) || (tool.output_schema !== undefined && !isObject(tool.output_schema)))
      return invalid("Each workflow tool needs a description of at most 4000 characters and object JSON schemas.");
    if (!["allow", "ask", "deny"].includes(tool.permission as string)) return invalid("Workflow tools need an explicit allow, ask, or deny permission.");
    if (tool.price_usd !== undefined && (typeof tool.price_usd !== "number" || !Number.isFinite(tool.price_usd) || tool.price_usd < 0))
      return invalid("A workflow tool price must be a nonnegative number.");
    return tool as SdkWorkflowTool;
  });
  if (adapters !== undefined && (!Array.isArray(adapters) || adapters.length > 2 || new Set(adapters).size !== adapters.length || adapters.some((adapter) => adapter !== "runNode" && adapter !== "runJudge")))
    return invalid("workflow_adapters may contain runNode and runJudge once each.");
  return { workflow_tools: manifest, workflow_adapters: (adapters ?? []) as SdkWorkflowAdapter[] };
}

export function sdkDraftTools(manifest: readonly SdkWorkflowTool[]) {
  return {
    tools: manifest.filter((tool) => tool.permission === "allow").map((tool) => tool.name),
    gated: Object.fromEntries(manifest.filter((tool) => tool.permission !== "allow").map((tool) => [tool.name, tool.permission])),
    deniedBy: Object.fromEntries(manifest.filter((tool) => tool.permission === "deny").map((tool) => [tool.name, "agent" as const])),
    asked: [], // The backend contract has no workflow-level approval callback. Never infer permission from a tool result.
  };
}
