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

/** One Idempotency-Key per request: sending the same request again (a retry after a lost answer) reuses its key, so the
 *  server answers with the run it already started; a changed request, or one after a run started, gets a new key. */
export function keeper(newKey: () => string = () => crypto.randomUUID()) {
  let held: { request: string; key: string } | null = null;
  return {
    keyFor(agentId: string, body: StartBody): string {
      const request = JSON.stringify([agentId, body]);
      if (held?.request !== request) held = { request, key: newKey() };
      return held.key;
    },
    done() { held = null; },
  };
}

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
