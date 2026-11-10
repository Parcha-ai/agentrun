// A server's tool snapshot and its version: the tools as tools/list gave them (the MCP wire shape), and one stable hash of
// them. The version is what an agent's save pins and what a later listing is compared with, so it reads only what a
// tool is (name, title, description, schemas, annotations), in sorted order, as canonical JSON: the same tools listed
// in another order, or with their fields in another order, are one version. Serve's registry keeps the same tools under
// `input_schema`/`output_schema` and computes the same version (serve src/mcp-snapshot.ts); the vector in both packages'
// tests holds the two to one answer.
import { createHash } from "node:crypto";

/** One tool as tools/list gives it, the fields a version reads. */
export type ListedTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with sorted keys, an undefined field no field: one text for one value. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** A tool reduced to the fields a version reads. */
export function versionedTool(tool: ListedTool): ListedTool {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? {},
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

/** The version of a server's listed tools: `sha256:` and the hex SHA-256 of their canonical JSON, sorted by name. */
export function snapshotVersion(tools: readonly ListedTool[]): string {
  const sorted = tools.map(versionedTool).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `sha256:${createHash("sha256").update(canonical(sorted), "utf8").digest("hex")}`;
}
