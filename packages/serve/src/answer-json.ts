// An answer's structured part: the last fenced `json` block of a final answer, parsed, and checked against an agent's
// output schema (definition.output_schema). The one reader of it: a completed agentic run's result.output (store-view.ts)
// and a template eval's schema and target graders (template-eval.ts) read an answer's JSON alike.
import { Compile } from "typebox/schema";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of the last fenced `json` block in `text` (```json or a longer fence, ~~~ too), or undefined. */
export function lastJsonBlock(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let found: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*json\s*$/i.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    const end = lines.findIndex((line, j) => j > i && new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line));
    if (end < 0) break;
    found = lines.slice(i + 1, end).join("\n");
    i = end;
  }
  return found;
}

/** The answer's last fenced json block, parsed, or why there is none. */
export function answerJson(answer: string): { value: unknown } | { why: string } {
  const block = lastJsonBlock(answer);
  if (block === undefined) return { why: "the answer has no fenced json block" };
  try {
    return { value: JSON.parse(block) };
  } catch (error) {
    return { why: `the answer's last json block is not JSON: ${(error as Error).message}` };
  }
}

/** A JSON Schema's checker: each problem of a value against it, by path, none for a value that meets it. */
export type SchemaCheck = (value: unknown) => string[];

/** `schema` compiled to its checker, or why it does not compile. */
export function schemaCheck(schema: unknown): { check: SchemaCheck } | { why: string } {
  if (!isObject(schema)) return { why: "it is not a JSON object" };
  try {
    const validator = Compile(schema as Parameters<typeof Compile>[0]);
    return { check: (value) => validator.Errors(value)[1].map((e) => `${e.instancePath || "/"} ${e.message}`) };
  } catch (error) {
    return { why: `it does not compile as a JSON Schema: ${(error as Error).message}` };
  }
}

/** A final answer's structured part against an agent's output schema: the value of its last fenced json block when it
 *  meets the schema, else why not (no block, not JSON, the first problems against the schema). */
export function structuredAnswer(answer: string, schema: unknown): { value: unknown } | { why: string } {
  const compiled = schemaCheck(schema);
  if ("why" in compiled) return { why: `the output schema ${compiled.why}` };
  const json = answerJson(answer);
  if ("why" in json) return json;
  const problems = compiled.check(json.value);
  return problems.length ? { why: `the answer's json does not meet the output schema: ${problems.slice(0, 3).join("; ")}` } : { value: json.value };
}
