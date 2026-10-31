export type StartBody = { input: unknown; revision?: string; effort?: string; max_cost_usd?: number };
export type StartForm = { text: string; revision?: string; effort?: string; maxCostUsd?: string };

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
    body.max_cost_usd = cap;
  }
  return { ok: true, body };
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; examples?: unknown[]; default?: unknown; enum?: unknown[]; description?: string };

/** A workflow's input to start from: its input schema's first example (or default), else the schema's shape with empty
 *  values (an object's required fields, a list empty, a string ""). Null when the workflow names no input schema. */
export function exampleInput(workflow: unknown): { text: string; from: "example" | "shape"; fields: { name: string; note?: string }[] } | null {
  const w = workflow as { input?: { schemaId?: string }; schemas?: Record<string, Schema> } | null;
  const schema = w?.input?.schemaId ? w.schemas?.[w.input.schemaId] : undefined;
  if (!schema) return null;
  const fields = Object.entries(schema.properties ?? {}).map(([name, p]) => ({ name, ...(p.description ? { note: p.description } : {}) }));
  const given = schema.examples?.[0] ?? schema.default;
  if (given !== undefined) return { text: JSON.stringify(given, null, 2), from: "example", fields };
  const shape = (s: Schema | undefined, depth = 0): unknown => {
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
export function curlFor(origin: string, agentId: string, body: StartBody, key: string): string {
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
