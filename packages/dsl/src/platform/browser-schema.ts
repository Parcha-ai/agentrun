import Value from "typebox/value";
import type { SchemaValidator } from "./contract.js";

// The browser has no typebox compiler: it generates code with `new Function`, which a browser page may not run
// (a content-security-policy without unsafe-eval) and which this entry never contains. typebox's interpreted
// checker answers the same Check and Errors for a schema that compiles, as test/platform-parity.test.mjs shows
// over the schemas the workflow documents use. A schema the compiler refuses is refused here too: an invalid
// pattern the compiler would reject at compile time is rejected when the validator is made, and so is a schema
// the checker cannot read.
const patternsOf = (schema: unknown, found: string[] = [], seen = new Set<object>()): string[] => {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return found;
  seen.add(schema);
  if (Array.isArray(schema)) { for (const item of schema) patternsOf(item, found, seen); return found; }
  const record = schema as Record<string, unknown>;
  if (typeof record.pattern === "string") found.push(record.pattern);
  if (record.patternProperties && typeof record.patternProperties === "object") found.push(...Object.keys(record.patternProperties));
  for (const value of Object.values(record)) patternsOf(value, found, seen);
  return found;
};

export function compileSchema(schema: unknown): SchemaValidator {
  for (const pattern of patternsOf(schema)) new RegExp(pattern, "u");
  Value.Check(schema as never, undefined);
  return {
    Check: (value) => Value.Check(schema as never, value),
    Errors: (value) => Value.Errors(schema as never, value),
  };
}
