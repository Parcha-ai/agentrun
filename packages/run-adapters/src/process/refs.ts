// A JSON Schema's local references, inlined. Written for AgentRun.
//
// Generated schemas (pydantic's above all) put each nested model and enum in `$defs` and point at it with a local
// `$ref` ("#/$defs/Address"). A bridge that reads one schema at a time needs them in place: each `$ref` is replaced by
// what it names, with the keywords beside it (a field's own `description` or `default`) laid over it, and `$defs` and
// `definitions` go. A reference that leaves the document, names nothing, or leads back to itself (a recursive model)
// cannot be inlined, and says so.

/** A reference that cannot be inlined: remote, unknown, or recursive. */
export class SchemaRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaRefError";
  }
}

const isPlain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** `schema` with every local `$ref` replaced by what it names; throws `SchemaRefError` for one that cannot be. */
export function inlineLocalRefs(schema: unknown): unknown {
  if (!isPlain(schema)) return schema;
  const target = (ref: string): unknown => {
    if (!ref.startsWith("#/")) throw new SchemaRefError(`the $ref "${ref.slice(0, 120)}" is not local to the schema`);
    let at: unknown = schema;
    for (const raw of ref.slice(2).split("/")) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isPlain(at) || !(part in at)) throw new SchemaRefError(`the $ref "${ref.slice(0, 120)}" names nothing in the schema`);
      at = at[part];
    }
    return at;
  };
  const walk = (node: unknown, seen: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, seen));
    if (!isPlain(node)) return node;
    const { $ref, ...rest } = node;
    const own: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === "$defs" || key === "definitions") continue;
      own[key] = walk(value, seen);
    }
    if (typeof $ref !== "string") return own;
    if (seen.includes($ref)) throw new SchemaRefError(`the $ref "${$ref.slice(0, 120)}" is recursive (${[...seen, $ref].join(" -> ").slice(0, 300)})`);
    const named = walk(target($ref), [...seen, $ref]);
    return isPlain(named) ? { ...named, ...own } : named;
  };
  return walk(schema, []);
}
