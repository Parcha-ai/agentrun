export type StartBody = { input: unknown; revision?: string; effort?: string; max_cost_usd?: number; file_ids?: string[]; repo?: string };
/** `fileIds`: the files the run names (uploaded with POST /v2/files), copied into its `inputs/` before it starts.
 *  `repo`: the GitHub repository (owner/name) the run reaches; empty takes the agent's one bound repository. */
export type StartForm = {
  text: string; revision?: string; effort?: string; maxCostUsd?: string; fileIds?: string[]; repo?: string;
  /** An agentic agent whose input_schema the form shows as fields: those fields, typed (lib/inputForm.ts), sent beside
   *  the message, and whether the message is required. */
  typed?: { fields: Record<string, unknown>; contentRequired: boolean };
  /** An agentic agent whose input_schema the form can't show as fields: `text` is its whole input, as JSON. */
  json?: boolean;
};

/** The body of `POST /v2/agents/{id}/runs` from the form. An agentic run's input is its first message, `{content}`, with
 *  its typed fields beside it when its agent has an input_schema; a workflow run's is its typed input, as JSON, as is an
 *  agentic run's whose schema the form can't show. A workflow run takes no spend cap (the server refuses one). */
export function startBody(kind: "agentic" | "workflow", f: StartForm): { ok: true; body: StartBody } | { ok: false; field: string; message: string } {
  let input: unknown;
  if (kind === "agentic" && f.json) {
    try { input = JSON.parse(f.text); } catch { return { ok: false, field: "input", message: "The agent's input is JSON: this is not." }; }
  } else if (kind === "agentic" && f.typed) {
    // An empty message is left out when the schema doesn't require it.
    if (f.typed.contentRequired && !f.text.trim()) return { ok: false, field: "input", message: "Write the run's message." };
    input = { ...(f.text.trim() ? { content: f.text } : {}), ...f.typed.fields };
  } else if (kind === "agentic") {
    if (!f.text.trim()) return { ok: false, field: "input", message: "Write the run's first message." };
    input = { content: f.text };
  } else {
    try { input = JSON.parse(f.text); } catch { return { ok: false, field: "input", message: "The workflow's input is JSON: this is not." }; }
  }
  const body: StartBody = { input };
  if (f.revision) body.revision = f.revision;
  if (f.effort) body.effort = f.effort;
  if (kind === "agentic" && f.maxCostUsd?.trim()) {
    const cap = Number(f.maxCostUsd);
    if (!Number.isFinite(cap) || cap <= 0) return { ok: false, field: "max_cost_usd", message: "A spend cap is a positive number of dollars." };
    body.max_cost_usd = cap;
  }
  if (f.fileIds?.length) body.file_ids = [...f.fileIds];
  // The repository field is the agent form's alone; a workflow start never reads it (a value kept from the agent
  // the person switched from is not sent, nor checked).
  const repo = kind === "agentic" ? f.repo?.trim() : undefined;
  if (repo) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { ok: false, field: "repo", message: "A repository is owner/name, like Parcha-ai/agentrun." };
    body.repo = repo;
  }
  return { ok: true, body };
}

export type Schema = { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; examples?: unknown[]; default?: unknown; enum?: unknown[]; description?: string; definitions?: Record<string, Schema>; $defs?: Record<string, Schema> };

/** A schema with its local `$ref` followed as the DSL resolves one: `#/definitions/<name>` (or `#/$defs/<name>`) names
 *  the input schema's own definition, else the workflow's schema of that name. A ref it cannot follow (or a cycle) is
 *  left as it is. */
function derefIn(root: Schema, schemas: Record<string, Schema>) {
  return (s: Schema | undefined): Schema | undefined => {
    const seen = new Set<string>();
    while (s?.$ref && !seen.has(s.$ref)) {
      seen.add(s.$ref);
      const name = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(s.$ref)?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~");
      const next = name === undefined ? undefined : root.definitions?.[name] ?? root.$defs?.[name] ?? (Object.hasOwn(schemas, name) ? schemas[name] : undefined);
      if (!next) break;
      s = next;
    }
    return s;
  };
}

/** An input to start from, and the fields it takes (exampleOf). */
export type ExampleInput = { text: string; from: "example" | "shape"; fields: { name: string; note?: string }[]; optional: string[] };

/** The line under a JSON input box: its example to edit, or its required fields to fill, naming the optional fields it
 *  also takes (left out of the box, so its own pre-fill never fails the schema). `then` is the button's verb; `whose`
 *  the input's (a workflow's, or an agent's whose input_schema the form can't show as fields). */
export function exampleHint(example: ExampleInput, then: "run" | "start", whose: "workflow" | "agent" = "workflow"): string {
  if (example.from === "example") return `The ${whose}'s example input. Edit it, then ${then}.`;
  const also = example.optional.length ? ` It also takes ${example.optional.join(", ")}, if you add ${example.optional.length === 1 ? "it" : "them"}.` : "";
  return `The ${whose}'s input, its required fields empty. Fill them in, then ${then}.${also}`;
}

/** A workflow's input to start from: its input schema's first example (or default), else the schema's shape with empty
 *  values (an object's required fields, a list empty, a string ""). Null when the workflow names no input schema. */
export function exampleInput(workflow: unknown): ExampleInput | null {
  const w = workflow as { input?: { schemaId?: string }; schemas?: Record<string, Schema> } | null;
  const declared = w?.input?.schemaId ? w.schemas?.[w.input.schemaId] : undefined;
  return declared ? exampleOf(declared, w?.schemas ?? {}) : null;
}

/** An input to start from for one schema, as exampleInput says it; `schemas` are the ones a `$ref` may name besides the
 *  schema's own definitions. */
export function exampleOf(declared: Schema, schemas: Record<string, Schema> = {}): ExampleInput {
  const deref = derefIn(declared, schemas);
  const schema = deref(declared)!;
  const fields = Object.entries(schema.properties ?? {}).map(([name, p]) => { const d = deref(p); return { name, ...(d?.description ? { note: d.description } : {}) }; });
  const given = schema.examples?.[0] ?? schema.default;
  if (given !== undefined) return { text: JSON.stringify(given, null, 2), from: "example", fields, optional: [] };
  const shape = (given: Schema | undefined, depth = 0): unknown => {
    const s = deref(given);
    if (!s || depth > 4) return null;
    if (s.examples?.length) return s.examples[0];
    if (s.default !== undefined) return s.default;
    if (s.enum?.length) return s.enum[0];
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    // Only the fields the schema requires: an optional one filled with an empty value can fail its own constraint (a
    // minLength, a pattern), so it is left for the person to add (#1926).
    if (t === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => (s.required ?? []).includes(k)).map(([k, v]) => [k, shape(v, depth + 1)]));
    if (t === "array") return [];
    if (t === "string") return "";
    if (t === "number" || t === "integer") return 0;
    if (t === "boolean") return false;
    return null;
  };
  const required = new Set(schema.required ?? []);
  return { text: JSON.stringify(shape(schema), null, 2), from: "shape", fields, optional: fields.map((f) => f.name).filter((n) => !required.has(n)) };
}

// One Idempotency-Key per request, as messages use it too (lib/idempotency.ts).
import { keeper } from "./idempotency";
export { keeper };

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The request as cURL for the code pane. The key is `$AGENTRUN_API_KEY`, an API client's (the server's own token is
 *  AGENTRUN_TOKEN, never a client's): a value never appears. */
export function curlFor(origin: string, agentId: string, body: StartBody, key: string): string {
  return [
    `curl -X POST ${sh(`${origin}/v2/agents/${agentId ? encodeURIComponent(agentId) : "{agent_id}"}/runs`)} \\`,
    `  -H "Authorization: Bearer $AGENTRUN_API_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H ${sh(`Idempotency-Key: ${key}`)} \\`,
    `  -d ${sh(JSON.stringify(body))}`,
  ].join("\n");
}

/** A run started only when the server said so (2xx). A lost answer (no status) or a refusal keeps the request's key, so
 *  sending it again is the same request and cannot start a second run. */
export const started = (status: number): boolean => status >= 200 && status < 300;

/** Sends one start under the request's key, and resets the key only when the run started (2xx): a refusal or a lost
 *  answer keeps it, so sending the same request again is a retry the server answers with the run it may have started,
 *  never a second run. Both start screens send through this. */
export async function submitStart<R extends { status: number }>(
  keys: ReturnType<typeof keeper>,
  agentId: string,
  body: StartBody,
  send: (agentId: string, body: StartBody, key: string) => Promise<R>,
): Promise<R> {
  const r = await send(agentId, body, keys.keyFor(agentId, body));
  if (started(r.status)) keys.done();
  return r;
}
