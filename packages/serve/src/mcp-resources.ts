// Resource operations use the same per-server grants, revision pins, credentials and run gate as MCP tools.
// Only our probe creates these entries; an upstream tools/list entry never supplies the operation marker.
export const RESOURCE_OPERATIONS = ["list", "templates", "read"] as const;
export type ResourceOperation = typeof RESOURCE_OPERATIONS[number];
export const RESOURCE_NAMES: Record<ResourceOperation, string> = {
  list: "agentrun_list_resources", templates: "agentrun_list_resource_templates", read: "agentrun_read_resource",
};
export const RESOURCE_URI_MAX = 8192;
export const RESOURCE_LIST_MAX = 500;
export const RESOURCE_LIST_BYTES = 1024 * 1024;
export const RESOURCE_PAGES_MAX = 64;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const reservedResourceName = (name: string): boolean => Object.values(RESOURCE_NAMES).includes(name);

export function resourceTools() {
  return RESOURCE_OPERATIONS.map(resource => ({
    name: RESOURCE_NAMES[resource], resource,
    title: resource === "list" ? "List resources" : resource === "templates" ? "List resource templates" : "Read resource",
    description: resource === "list" ? "List the resources available from this MCP server."
      : resource === "templates" ? "List this MCP server's resource URI templates."
      : "Read a resource URI from this MCP server. The URI is sent to the server, never fetched directly.",
    input_schema: { type: "object", properties: resource === "read" ? { uri: { type: "string", minLength: 1, maxLength: RESOURCE_URI_MAX } } : {}, ...(resource === "read" ? { required: ["uri"] } : {}), additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));
}

/** A stored marker is accepted only with its exact operation name and bounded schema. Older ordinary tools without
 *  a marker remain ordinary tools; a name alone never turns tools/call into resources/read. */
export function resourceToolProblem(value: unknown): string | undefined {
  if (!object(value) || value.resource === undefined) return undefined;
  const op = value.resource;
  if (typeof op !== "string" || !(RESOURCE_OPERATIONS as readonly string[]).includes(op) || value.name !== RESOURCE_NAMES[op as ResourceOperation]) return "invalid resource operation marker";
  const schema = value.inputSchema ?? value.input_schema;
  const read = op === "read";
  if (!object(schema) || !keysAre(schema, read ? ["type", "properties", "required", "additionalProperties"] : ["type", "properties", "additionalProperties"]) || schema.type !== "object" || schema.additionalProperties !== false || !object(schema.properties)) return "invalid resource operation schema";
  if (!keysAre(schema.properties, read ? ["uri"] : [])) return "invalid resource operation arguments";
  if (read) {
    const uri = schema.properties.uri;
    if (!object(uri) || !keysAre(uri, ["type", "minLength", "maxLength"]) || uri.type !== "string" || uri.minLength !== 1 || uri.maxLength !== RESOURCE_URI_MAX || !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "uri") return "invalid resource URI schema";
  }
  if (!object(value.annotations) || value.annotations.readOnlyHint !== true || value.annotations.destructiveHint !== false) return "invalid resource operation effect";
  return undefined;
}

export function resourceToolOperation(value: unknown): ResourceOperation | undefined {
  return object(value) && value.resource !== undefined && resourceToolProblem(value) === undefined ? value.resource as ResourceOperation : undefined;
}

type ResourceClient = { request(input: unknown, options: unknown): Promise<unknown> };
/** One bounded logical operation. Pagination belongs to this operation's deadline and fails if incomplete. */
export async function resourceResult(client: ResourceClient, operation: ResourceOperation, args: Record<string, unknown>, signal: AbortSignal, timeout: number, clean: (text: string) => string): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  if (!keysAre(args, operation === "read" ? ["uri"] : [])) throw new Error("The resource operation has unexpected or missing arguments.");
  if (operation === "read") {
    if (typeof args.uri !== "string" || !args.uri.length || args.uri.length > RESOURCE_URI_MAX || /[\u0000-\u001f\u007f]/.test(args.uri)) throw new Error("A resource URI must be bounded text without control characters.");
    const answer = await client.request({ method: "resources/read", params: { uri: args.uri } }, { signal, timeout });
    if (!object(answer) || !Array.isArray(answer.contents) || answer.contents.length > RESOURCE_LIST_MAX || answer.contents.some(item => !object(item) || typeof item.uri !== "string" || (typeof item.text !== "string" && typeof item.blob !== "string"))) throw new Error("The MCP server returned invalid resource contents.");
    for (const item of answer.contents) if (typeof item.blob === "string") {
      // The wire caps the whole response. Check the decoded binary too: a JSON-only scrub cannot see a token
      // encoded inside a BlobResourceContents. Withhold it rather than corrupting arbitrary binary bytes.
      const bytes = Buffer.from(item.blob, "base64");
      if (bytes.toString("base64") !== item.blob) throw new Error("The MCP server returned an invalid base64 resource.");
      const decoded = bytes.toString("utf8");
      if (clean(decoded) !== decoded) throw new Error("The MCP resource contained a connection credential; its contents were withheld.");
    }
    return { content: answer.contents.map(resource => ({ type: "resource", resource })) };
  }
  const method = operation === "list" ? "resources/list" : "resources/templates/list";
  const key = operation === "list" ? "resources" : "resourceTemplates";
  const items: unknown[] = [], cursors = new Set<string>();
  let cursor: string | undefined, bytes = 0;
  for (let pageNumber = 0; pageNumber < RESOURCE_PAGES_MAX; pageNumber++) {
    signal.throwIfAborted();
    const answer = await client.request({ method, ...(cursor === undefined ? {} : { params: { cursor } }) }, { signal, timeout });
    if (!object(answer) || !Array.isArray(answer[key])) throw new Error("The MCP server returned an invalid resource list.");
    for (const item of answer[key]) {
      if (!object(item) || typeof item.name !== "string" || typeof item[operation === "list" ? "uri" : "uriTemplate"] !== "string") throw new Error("The MCP server returned an invalid resource entry.");
      items.push(item); bytes += Buffer.byteLength(JSON.stringify(item));
      if (items.length > RESOURCE_LIST_MAX || bytes > RESOURCE_LIST_BYTES) throw new Error("The MCP server's resource listing exceeds the item or byte limit; no incomplete listing was returned.");
    }
    if (answer.nextCursor === undefined) return { structuredContent: { [key]: items } };
    if (typeof answer.nextCursor !== "string" || answer.nextCursor.length > 4096 || cursors.has(answer.nextCursor)) throw new Error("The MCP server's resource cursor is invalid or repeats; no incomplete listing was returned.");
    cursors.add(answer.nextCursor); cursor = answer.nextCursor;
  }
  throw new Error("The MCP server's resource list did not finish within the page limit.");
}
