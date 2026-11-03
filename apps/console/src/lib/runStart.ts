export type StartBody = { input: unknown; revision?: string; effort?: string; max_cost_usd?: number };
/** The request as the form has it, for the code pane: a cap that is not a number is kept as typed. */
export type PreviewBody = Omit<StartBody, "max_cost_usd"> & { max_cost_usd?: number | string };
/** `minCapUsd`: the agent's least cap (GET /agents/{id} min_cap_usd): a cap under it is refused here as the server
 *  refuses it (`cap >= min_cap_usd`); null, no cap can be kept on its model; absent, the server said nothing. */
export type StartForm = { text: string; revision?: string; effort?: string; maxCostUsd?: string; minCapUsd?: number | null };

/** The least cap in dollars, rounded up to a cent, so a cap of what it says is never under it. */
const dollarsAtLeast = (usd: number) => `$${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`;
/** The cap field's hint from the agent's least cap: the least (at default effort, when another effort is chosen: the
 *  server works it out at the agent's default), that none can be kept, or nothing when the server says nothing. */
export function capHint(minCapUsd: number | null | undefined, effortChosen: boolean): string | undefined {
  if (minCapUsd === undefined) return undefined;
  if (minCapUsd === null) return "No cap can be kept on this agent's model.";
  return `At least ${dollarsAtLeast(minCapUsd)} for this agent${effortChosen ? ", at default effort" : ""}.`;
}

/** The body of `POST /v2/agents/{id}/runs` from the form. An agentic run's input is its first message, `{content}`; a
 *  workflow run's is its typed input, as JSON. A workflow run takes no spend cap (the server refuses one). */
export function startBody(kind: "agentic" | "workflow", f: StartForm): { ok: true; body: StartBody } | { ok: false; field: string; message: string } {
  let input: unknown;
  if (kind === "agentic") {
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
    if (f.minCapUsd === null) return { ok: false, field: "max_cost_usd", message: "No cap can be kept on this agent's model." };
    if (typeof f.minCapUsd === "number" && cap < f.minCapUsd) return { ok: false, field: "max_cost_usd", message: `At least ${dollarsAtLeast(f.minCapUsd)} for this agent.` };
    body.max_cost_usd = cap;
  }
  return { ok: true, body };
}

/** The request the form says, as entered, for the code pane and the JSON view: startBody's body when the form is valid,
 *  else the same fields with nothing refused or dropped (a workflow input that is not JSON, as typed; a cap under the
 *  agent's least, as the number it is; one that is not a number, as typed). A copied request is then refused as the form
 *  is, never sent without the cap, revision or effort the form names. */
export function previewBody(kind: "agentic" | "workflow", f: Omit<StartForm, "minCapUsd">): PreviewBody {
  let input: unknown = kind === "agentic" ? { content: f.text } : f.text;
  if (kind === "workflow") { try { input = JSON.parse(f.text); } catch { /* kept as typed */ } }
  const body: PreviewBody = { input };
  if (f.revision) body.revision = f.revision;
  if (f.effort) body.effort = f.effort;
  const cap = f.maxCostUsd?.trim();
  if (kind === "agentic" && cap) body.max_cost_usd = Number.isFinite(Number(cap)) ? Number(cap) : cap;
  return body;
}

type Schema = { $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; examples?: unknown[]; default?: unknown; enum?: unknown[]; description?: string; definitions?: Record<string, Schema> };

/** A schema with its local `$ref` followed as the DSL resolves one: `#/definitions/<name>` names the input schema's own
 *  definition, else the workflow's schema of that name. A ref it cannot follow (or a cycle) is left as it is. */
function derefIn(root: Schema, schemas: Record<string, Schema>) {
  return (s: Schema | undefined): Schema | undefined => {
    const seen = new Set<string>();
    while (s?.$ref && !seen.has(s.$ref)) {
      seen.add(s.$ref);
      const name = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(s.$ref)?.[1]?.replace(/~1/g, "/").replace(/~0/g, "~");
      const next = name === undefined ? undefined : root.definitions?.[name] ?? (Object.hasOwn(schemas, name) ? schemas[name] : undefined);
      if (!next) break;
      s = next;
    }
    return s;
  };
}

/** A workflow's input to start from: its input schema's first example (or default), else the schema's shape with empty
 *  values (an object's required fields, a list empty, a string ""). Null when the workflow names no input schema. */
export function exampleInput(workflow: unknown): { text: string; from: "example" | "shape"; fields: { name: string; note?: string }[] } | null {
  const w = workflow as { input?: { schemaId?: string }; schemas?: Record<string, Schema> } | null;
  const declared = w?.input?.schemaId ? w.schemas?.[w.input.schemaId] : undefined;
  if (!declared) return null;
  const deref = derefIn(declared, w?.schemas ?? {});
  const schema = deref(declared)!;
  const fields = Object.entries(schema.properties ?? {}).map(([name, p]) => { const d = deref(p); return { name, ...(d?.description ? { note: d.description } : {}) }; });
  const given = schema.examples?.[0] ?? schema.default;
  if (given !== undefined) return { text: JSON.stringify(given, null, 2), from: "example", fields };
  const shape = (given: Schema | undefined, depth = 0): unknown => {
    const s = deref(given);
    if (!s || depth > 4) return null;
    if (s.examples?.length) return s.examples[0];
    if (s.default !== undefined) return s.default;
    if (s.enum?.length) return s.enum[0];
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    if (t === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => !s.required || s.required.includes(k)).map(([k, v]) => [k, shape(v, depth + 1)]));
    if (t === "array") return [];
    if (t === "string") return "";
    if (t === "number" || t === "integer") return 0;
    if (t === "boolean") return false;
    return null;
  };
  return { text: JSON.stringify(shape(schema), null, 2), from: "shape", fields };
}

// One Idempotency-Key per request, as messages use it too (lib/idempotency.ts).
import { keeper } from "./idempotency";
export { keeper };

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The request as cURL for the code pane. The token is `$AGENTRUN_TOKEN`: a value never appears. */
export function curlFor(origin: string, agentId: string, body: PreviewBody, key: string): string {
  return [
    `curl -X POST ${sh(`${origin}/v2/agents/${encodeURIComponent(agentId)}/runs`)} \\`,
    `  -H "Authorization: Bearer $AGENTRUN_TOKEN" \\`,
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
