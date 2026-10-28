// DSL vocabulary that may sit on a schema but is not JSON Schema: System One's question keyword. The model never sees it.
const DSL_ONLY_SCHEMA_KEYWORDS = new Set(["criteria"]);

/** The input schema of a node runner's `submit` tool: the node's output schema under `value`, as
 *  `{ value: <schema> }`. A node schema is not a valid tool input as it stands (a root `$ref` or `$defs`
 *  is not an object schema), and embedding it moves the document root its local pointers resolve
 *  against, so each local `$ref` (`#`, `#/...`) is relocated under `#/properties/value`. A subschema
 *  that sets its own `$id` is a separate resource: its local references do not move. Every runner that
 *  delivers a node's record through a tool call uses this one envelope, so a schema behaves the same on
 *  every harness. A keyword of the DSL's own (`criteria`) is left out of every schema in it, never a property or
 *  definition of that name; the submission is still checked against the node's schema as written. */
export function submitParameters(schema: unknown): Record<string, unknown> {
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const singles = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "additionalItems", "contains", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]);
  const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const relocate = (node: unknown, resourceScope = false): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return structuredClone(node);
    // $id establishes a separate schema resource: its local references do not move.
    resourceScope ||= typeof (node as Record<string, unknown>).$id === "string" && (node as Record<string, unknown>).$id !== "";
    const child = (value: unknown) => relocate(value, resourceScope);
    return Object.fromEntries(Object.entries(node).filter(([key]) => !DSL_ONLY_SCHEMA_KEYWORDS.has(key)).map(([key, value]) => {
      if (!resourceScope && key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
        return [key, `#/properties/value${value.slice(1)}`];
      }
      if (maps.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        return [key, Object.fromEntries(Object.entries(value).map(([name, value]) => [name, child(value)]))];
      }
      if (arrays.has(key) && Array.isArray(value)) return [key, value.map(child)];
      if (singles.has(key)) return [key, Array.isArray(value) ? value.map(child) : child(value)];
      if (key === "dependencies" && value && typeof value === "object" && !Array.isArray(value)) {
        return [key, Object.fromEntries(Object.entries(value).map(([name, value]) => [name, Array.isArray(value) ? structuredClone(value) : child(value)]))];
      }
      // Annotations and literal values are data, not schemas (including a literal $ref).
      return [key, structuredClone(value)];
    }));
  };
  return { type: "object", properties: { value: relocate(schema) }, required: ["value"], additionalProperties: false };
}
