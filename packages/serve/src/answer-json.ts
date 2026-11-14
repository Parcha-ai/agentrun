// An answer's structured part: the last fenced `json` block of a final answer, parsed, and checked against an agent's
// output schema (definition.output_schema). The one reader of it: a completed agentic run's result.output (store-view.ts)
// and a template eval's schema and target graders (template-eval.ts) read an answer's JSON alike. The runner tells the
// model the schema (outputContract, in every harness's system prompt) and asks once more on a miss (outputRetryWords,
// runner/adapter-loop.ts).
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

/** The section every harness's system prompt ends its instructions with when the agent has an output schema
 *  (definition.output_schema): the schema itself, so the model is told the shape it answers in, never left to find a file.
 *  Undefined for an agent with none (or a schema that is not an object, which a save refuses). */
export function outputContract(schema: unknown): string | undefined {
  if (!isObject(schema)) return undefined;
  return `End your final answer with exactly one \`\`\`json block that matches this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
}

/** The one retry turn's message (the server's, never the person's): sent once, in the same session, when a run would end
 *  with an answer whose last json block misses its output schema. `why` is outputMiss's. */
export const outputRetryWords = (why: string): string => `Your final JSON did not match the output schema: ${why}. Reply again, ending with the corrected json block.`;

/** Why `answer` misses `schema`, in the retry's words (no block, not JSON, or the first problems against the schema, which
 *  the retry's own sentence already says are the schema's), or undefined when it meets it. Undefined too when the schema
 *  does not compile (a save refuses one): asking the model again cannot mend a schema. */
export function outputMiss(answer: string, schema: unknown): string | undefined {
  const compiled = schemaCheck(schema);
  if ("why" in compiled) return undefined;
  const json = answerJson(answer);
  if ("why" in json) return json.why;
  const problems = compiled.check(json.value);
  return problems.length ? problems.slice(0, 3).join("; ") : undefined;
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
