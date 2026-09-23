function collectRefNames(schema: unknown, out: Set<string>): void {
  if (Array.isArray(schema)) { for (const item of schema) collectRefNames(item, out); return; }
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "$ref" && typeof value === "string") {
      const match = value.match(/^#\/definitions\/(.+)$/);
      if (match) out.add(match[1]);
    } else collectRefNames(value, out);
  }
}

export function resolveSchemaForWorkflow(workflow: { schemas: Record<string, Record<string, unknown>> }, schema: Record<string, unknown>): Record<string, unknown> {
  const needed = new Set<string>();
  collectRefNames(schema, needed);
  if (!needed.size) return schema;
  const definitions: Record<string, unknown> = Object.assign(Object.create(null), (schema.definitions as Record<string, unknown>) || {});
  const queue = [...needed];
  while (queue.length) {
    const name = queue.pop()!;
    if (definitions[name] !== undefined) continue;
    const target = Object.hasOwn(workflow.schemas, name) ? workflow.schemas[name] : undefined;
    if (target === undefined) continue;
    definitions[name] = target;
    const transitive = new Set<string>();
    collectRefNames(target, transitive);
    for (const next of transitive) if (definitions[next] === undefined) queue.push(next);
  }
  // TypeBox's reference cache treats Object.prototype names specially. Alias only those
  // declared names at the compiler boundary; retain original definitions for diagnostics.
  const aliases = new Map<string, string>();
  for (const name of Object.keys(definitions)) {
    if (!Object.hasOwn(Object.prototype, name)) continue;
    let alias = `agentrun_definition_${Buffer.from(name).toString("hex")}`;
    while (Object.hasOwn(definitions, alias)) alias += "_";
    aliases.set(name, alias);
    definitions[alias] = definitions[name];
  }
  const resolved = { ...schema, definitions: { ...definitions } };
  if (!aliases.size) return resolved;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const name = key === "$ref" && typeof item === "string" ? item.match(/^#\/definitions\/(.+)$/)?.[1] : undefined;
      return [key, name && aliases.has(name) ? `#/definitions/${aliases.get(name)}` : rewrite(item)];
    }));
  };
  return rewrite(resolved) as Record<string, unknown>;
}

