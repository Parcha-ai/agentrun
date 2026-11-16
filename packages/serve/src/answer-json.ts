// An answer's structured part: the last fenced `json` block of a final answer, parsed, and checked against an agent's
// output schema (definition.output_schema). The one reader of it: a completed agentic run's result.output (store-view.ts)
// and a template eval's target graders (template-eval.ts) read an answer's JSON alike. The runner tells the
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
type Validator = ReturnType<typeof Compile>;

/** Compiled schemas by their JSON: an agent's runs check against the same few schemas over and over. */
const compiledSchemas = new Map<string, Validator>();

/** `schema` compiled to its checker (and the compiled validator, for a caller that reads each error's keyword and path),
 *  or why it does not compile. The one wrapper of the compiler: the most recent 256 schemas are kept compiled. `misses`:
 *  the same problems as `check`, each with the JSON Pointer of the value it is about apart from its words. */
export function schemaCheck(schema: unknown): { check: SchemaCheck; misses: (value: unknown) => { path: string; words: string }[]; validator: Validator } | { why: string } {
  if (!isObject(schema)) return { why: "it is not a JSON object" };
  const key = JSON.stringify(schema);
  let validator = compiledSchemas.get(key);
  if (!validator) {
    try {
      validator = Compile(schema as Parameters<typeof Compile>[0]);
    } catch (error) {
      return { why: `it does not compile as a JSON Schema: ${(error as Error).message}` };
    }
    if (compiledSchemas.size >= 256) compiledSchemas.delete(compiledSchemas.keys().next().value!);
    compiledSchemas.set(key, validator);
  }
  const compiled = validator;
  const misses = (value: unknown) => compiled.Errors(value)[1].map((e) => ({ path: e.instancePath, words: `${e.instancePath || "/"} ${e.message}` }));
  return { validator: compiled, misses, check: (value) => misses(value).map((miss) => miss.words) };
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

/** How structuredAnswer starts the why of a json block the schema refuses; the retry's own sentence already says it. */
const MISSES = "the answer's json does not meet the output schema: ";

/** Why `answer` misses `schema`, in the retry's words (structuredAnswer's why, less MISSES), or undefined when it meets
 *  it. Undefined too when the schema does not compile (a save refuses one): asking the model again cannot mend a schema. */
export function outputMiss(answer: string, schema: unknown): string | undefined {
  if ("why" in schemaCheck(schema)) return undefined;
  const read = structuredAnswer(answer, schema);
  return "why" in read ? read.why.replace(MISSES, "") : undefined;
}

/** A final answer's structured part against an agent's output schema: the value of its last fenced json block when it
 *  meets the schema, else why not (no block, not JSON, the first problems against the schema). */
export function structuredAnswer(answer: string, schema: unknown): { value: unknown } | { why: string } {
  const compiled = schemaCheck(schema);
  if ("why" in compiled) return { why: `the output schema ${compiled.why}` };
  const json = answerJson(answer);
  if ("why" in json) return json;
  const problems = compiled.check(json.value);
  return problems.length ? { why: `${MISSES}${problems.slice(0, 3).join("; ")}` } : { value: json.value };
}

/** A JSON object schema's one field a bare value fills: its only property, else its only required one; undefined for
 *  any other schema. */
function oneFieldOf(schema: unknown): string | undefined {
  if (!isObject(schema)) return undefined;
  const properties = isObject(schema.properties) ? Object.keys(schema.properties) : [];
  if (properties.length === 1) return properties[0];
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  return required.length === 1 ? required[0] : undefined;
}

/** A learned workflow's answer (`output`, as its tool hands it back: learned-workflow.ts learnedOutput) as a run serves it
 *  to an agent with output schema `schema`: the one function serving, a replay and the grade path read it through, so
 *  each sees the answer as the run presents it. No schema: the output as it is. With one: an output whose fenced json
 *  block already meets it, as it is; else its value shaped to the schema (the output as JSON when it parses, else its
 *  text; a value that is no object fills the schema's one field, oneFieldOf: a one-field workflow's bare "5462" is
 *  `{"mcc": "5462"}`, never the number; an object output is only itself), the first shape that meets the schema, fenced as the answer's one json block;
 *  `value` is what structuredAnswer reads back from `text`. None meets it: why, and the job goes back to the agent. */
export function answerAsServed(output: string, schema: unknown): { text: string; value: unknown } | { why: string } {
  if (schema === undefined) return { text: output, value: output };
  const compiled = schemaCheck(schema);
  if ("why" in compiled) return { why: `the agent's output schema ${compiled.why}` };
  const written = structuredAnswer(output, schema);
  if ("value" in written) return { text: output, value: written.value };
  const field = oneFieldOf(schema);
  const values: unknown[] = [];
  try {
    values.push(JSON.parse(output));
  } catch {
    // Not JSON: its text alone.
  }
  // An object output is its own shape: one that fails the schema goes back to the agent, never as its own text in a field.
  if (!isObject(values[0])) values.push(output);
  const shapes = values.flatMap((value) => (isObject(value) || field === undefined ? [value] : [value, { [field]: value }]));
  const meets = shapes.find((shape) => !compiled.check(shape).length);
  if (meets !== undefined) return { text: `\`\`\`json\n${JSON.stringify(meets, null, 2)}\n\`\`\``, value: meets };
  // Said against the object shape (the one-field object a bare value fills), else the first.
  const problems = compiled.check(shapes.find(isObject) ?? shapes[0]);
  return { why: `its answer does not meet the agent's output schema: ${problems.slice(0, 3).join("; ")}` };
}
