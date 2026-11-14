// monid (monid.ai): one key, and a listing of paid data endpoints from many providers. An agent is granted endpoints by
// name, `monid:<provider>/<endpoint>` or a provider's `monid:<provider>/*` (tool-names.ts), and each granted endpoint is
// one tool of its own, on every harness: its description, input and price as monid listed them when the agent was saved.
//
// At the save (server.ts saveable, the one check of a create, an edit and an inline run): each grant is read against
// monid's listing (a provider's wildcard: every endpoint it lists, GET /v1/endpoints; one endpoint: POST /v1/inspect),
// and the pin (MonidPin) is stamped on the revision. A grant monid does not list is refused in words, so is one that
// cannot be read now (no key, monid unreachable). A run reads its revision's pin and never monid's listing.
//
// At a run (runner/monid-run.ts): each pinned endpoint is one host tool, by its catalog name (its wire name on the
// harness, catalog.ts wireName). The gate asks about it by that name, its card shows its pinned price, and a call is a
// paid step on the run's one ledger (paid-calls.ts paidStep) named by it: held at the pinned price before it is sent,
// refused unsent unless that fits the cap with what the run has spent and holds, then settled once at what monid says it
// charged, else at its hold unless monid says it charged nothing. An endpoint priced by usage (per result, per unit) has
// no fixed price: it is held at MONID_USAGE_CEILING_USD, the declared ceiling, and settled at its charge the same way.
//
// A run is sent once and never again: it spends money, and a request that failed after it left may have run. An async
// provider answers 202 with a run id, read again every POLL_MS until it ends, for at most WAIT_MS in all; a run the
// caller stops, or one that outlasts the wait, is asked to stop. Every answer reaches the model as JSON, cut at CLIP
// characters, the whole of it then filed under the run's work/evidence/monid/.
import { randomUUID } from "node:crypto";
import { type Workspace, workspaceErrorWords } from "./workspace/index.js";
import { wireName } from "./catalog.js";
import { formatToolName, parseToolName } from "./tool-names.js";
import { redacted } from "./key-refusal.js";
import type { MonidPinBody } from "./store/agent-body.js";
import { isObject, type Json } from "./validate.js";

export const MONID_KEY_ENV = "MONID_API_KEY";
/** Under `faux` only (startServe's `fauxMonid`): a module whose default export is the fetch monid's calls go through, in
 *  place of monid's API (the tests' fake). */
export const FAUX_MONID_ENV = "AGENTRUN_SERVE_FAUX_MONID";
export const MONID_API = "https://api.monid.ai";
/** The most characters of one answer the model reads. */
export const CLIP = 60_000;
/** What one call of an endpoint monid prices by usage (per result, per unit: no fixed price) is held at: the declared
 *  ceiling, the one rule for such a call. The card shows it, the cap holds it until monid says what the call charged. */
export const MONID_USAGE_CEILING_USD = 1;
/** The most endpoints one provider's wildcard pins: a provider that lists more is granted endpoint by endpoint. */
export const MONID_WILDCARD_MAX = 50;
const TERMINAL = ["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"];
/** The shortest limit a read of a run gets near the deadline: it outlives the deadline by this much at most. */
const MIN_READ_MS = 100;
/** How many inspects a save has out at once. */
const INSPECTS_AT_ONCE = 8;
/** A save's read of the listing or an inspect, refused for the rate (429) or failed by monid (5xx), is read again after
 *  what monid says to wait (Retry-After, 2 s when it says nothing, at most READ_WAIT_MS), READ_TRIES times in all. */
const READ_TRIES = 4;
const READ_WAIT_MS = 10_000;

/** monid's answer, or `error` saying why there is none, with the HTTP `status` when one came. */
export type MonidAnswer = Json & { error?: string };
/** On an answer monid charged nothing for: the run never ran (refused as sent), was blocked or stopped, or the provider
 *  failed. A symbol, so the model never reads it. */
const UNCHARGED = Symbol("monid.uncharged");
const uncharged = (answer: MonidAnswer): MonidAnswer => Object.assign(answer, { [UNCHARGED]: true });
export type MonidOptions = {
  key: string;
  fetch?: typeof fetch;
  /** Each request's own limit (30 s), but a run's first, which gets the whole wait: a sync provider answers in it. */
  requestMs?: number;
  /** Between two reads of an async run (2 s). */
  pollMs?: number;
  /** The most a run is waited for, its first request and every read together (150 s: monid's runs take 1 to 120 s). */
  waitMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
});

/** An amount monid reports (`{value, currency, unit?}`), in its currency: a micro-dollar amount in dollars. */
const money = (amount: unknown) => (isObject(amount) && typeof amount.value === "number" ? { value: amount.unit === "MICRO_DOLLAR" ? amount.value / 1e6 : amount.value, currency: String(amount.currency ?? "USD") } : undefined);
/** What a run cost: `cost` on a run read back, else a sync answer's settled `billing.reportedCost`. */
export const costOf = (record: Json) => money(record.cost) ?? money(isObject(record.billing) ? record.billing.reportedCost : undefined);

/** Why a request got no answer to pass on, in words. */
function failure(status: number, body: Json): MonidAnswer {
  const said = typeof body.message === "string" ? body.message : JSON.stringify(body).slice(0, 500);
  if (status === 402) return { error: `the monid wallet's balance is too low for this call (402): ${said}`, status };
  if (status === 401) return { error: `monid refused the key (401): ${said}`, status };
  return status ? { error: `monid answered ${status}: ${said}`, status } : { error: `monid could not be reached: ${said}` };
}

/** A run's record as the model reads it: its output, or why it has none, with its id and cost. */
function outcome(status: number, record: Json): MonidAnswer {
  const cost = costOf(record);
  const at = { ...(typeof record.runId === "string" ? { runId: record.runId } : {}), ...(cost ? { cost } : {}) };
  const state = typeof record.status === "string" ? record.status : status === 408 ? "TIMED_OUT" : undefined;
  const provider = isObject(record.providerResponse) ? record.providerResponse : {};
  const code = Number(provider.httpStatus ?? 200);
  if (state === "COMPLETED" && code >= 400) {
    const said = isObject(provider.error) && typeof provider.error.message === "string" ? provider.error.message : "no message";
    return uncharged({ error: `the provider answered ${code}: ${said} (monid charges nothing for a provider's error)`, status: code, ...at });
  }
  if (state === "COMPLETED") return { ...record, ...at };
  if (state === "BLOCKED") return uncharged({ error: `a control gate of the monid workspace, such as its budget, refused the run (BLOCKED): ${typeof record.reason === "string" ? record.reason : "no reason given"}`, ...(record.controls !== undefined ? { controls: record.controls } : {}), ...at });
  if (state === "FAILED") return { error: "the run failed inside monid (FAILED); it is not sent again", ...at };
  if (state === "TIMED_OUT") return { error: "the run went past monid's time budget (TIMED_OUT)", status: 408, ...at };
  if (state === "STOPPED") return uncharged({ error: "the run was stopped before it completed (STOPPED); a stopped run is not billed", ...at });
  // Refused as it was sent (a 4xx other than a timeout): it never ran. Any other answer with no state may have run.
  const refused = { ...failure(status, record), ...at };
  return status >= 400 && status < 500 && status !== 408 ? uncharged(refused) : refused;
}

/** What a run's answer says monid charged, in USD: its cost; else undefined when monid charged nothing (UNCHARGED), and
 *  null for every other answer, which may have been charged (one with no cost, FAILED, TIMED_OUT, a run stopped by its
 *  caller or the wait, a run whose sending failed): never $0 for a charge no one knows, and counted by the cap at what
 *  the run was held at (paidStep). A cost in another currency is unknown too. */
export function chargeOf(answer: MonidAnswer): number | null | undefined {
  const cost = money(answer.cost);
  if (cost) return cost.currency === "USD" ? cost.value : null;
  return (answer as { [UNCHARGED]?: true })[UNCHARGED] ? undefined : null;
}

/** monid's calls on `key`, each answering what its caller reads, never throwing. */
export function monidClient(options: MonidOptions) {
  const { key, requestMs = 30_000, pollMs = 2_000, waitMs = 150_000, sleep = pause } = options;
  const send = options.fetch ?? fetch;
  const call = async (method: string, path: string, body: Json | undefined, signal?: AbortSignal, ms = requestMs): Promise<{ status: number; body: Json; retryAfter?: number }> => {
    const limit = AbortSignal.timeout(ms);
    try {
      const res = await send(`${MONID_API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, limit]) : limit });
      const text = await res.text();
      const json: unknown = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
      const retryAfter = Number(res.headers?.get?.("retry-after") ?? NaN);
      return { status: res.status, body: isObject(json) ? json : { message: text.slice(0, 500) }, ...(retryAfter >= 0 ? { retryAfter } : {}) };
    } catch (error) {
      return { status: 0, body: { message: signal?.aborted ? "stopped by the caller" : limit.aborted ? `no answer in ${ms / 1000} s` : String((error as Error)?.message ?? error) } };
    }
  };
  const answer = (res: { status: number; body: Json }): MonidAnswer => (res.status >= 200 && res.status < 300 ? res.body : failure(res.status, res.body));
  /** A save's read, safe to repeat (READ_TRIES). */
  const read = async (method: string, path: string, body: Json | undefined, signal?: AbortSignal) => {
    for (let tries = 1; ; tries++) {
      const res = await call(method, path, body, signal);
      if ((res.status !== 429 && res.status < 500) || tries >= READ_TRIES || signal?.aborted) return res;
      await sleep(Math.min(READ_WAIT_MS, (res.retryAfter ?? 2) * 1000), signal);
    }
  };
  const stop = async (runId: string, why: string): Promise<MonidAnswer> => {
    const res = await call("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`, undefined, undefined, 10_000);
    return { error: `the run ${why}; ${res.status === 202 ? "monid was asked to stop it" : `monid refused to stop it (${res.status || "no answer"})`}, and a metered endpoint bills what it used before the stop`, runId };
  };
  return {
    /** One page of monid's listing (GET /v1/endpoints): `items`, and `cursor` for the next page when there is one. */
    endpoints: async (cursor: string | undefined, signal?: AbortSignal) => answer(await read("GET", `/v1/endpoints?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, signal)),
    inspect: async (args: { provider: string; endpoint: string }, signal?: AbortSignal) => answer(await read("POST", "/v1/inspect", args, signal)),
    async run(args: { provider: string; endpoint: string; input?: Json }, signal?: AbortSignal): Promise<MonidAnswer> {
      const deadline = Date.now() + waitMs;
      const first = await call("POST", "/v1/run", { provider: args.provider, endpoint: args.endpoint, input: args.input ?? {} }, signal, waitMs);
      if (first.status === 0) return { error: `${first.body.message}: the run may have gone ahead at monid, and is not sent again` };
      if (first.status !== 202 || typeof first.body.runId !== "string") return outcome(first.status, first.body);
      const runId = first.body.runId;
      for (let record = first.body; ; ) {
        if (TERMINAL.includes(String(record.status))) return outcome(200, record);
        if (signal?.aborted) return stop(runId, "was stopped by the caller");
        if (Date.now() >= deadline) return stop(runId, `did not end in ${waitMs / 1000} s`);
        await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())), signal);
        // Past the deadline, or stopped, the stop goes now: a read here would hold it while the paid run goes on.
        if (signal?.aborted || Date.now() >= deadline) continue;
        const polled = await call("GET", `/v1/runs/${encodeURIComponent(runId)}`, undefined, signal, Math.min(requestMs, Math.max(MIN_READ_MS, deadline - Date.now())));
        // A read is safe to repeat: no answer, a 429 or a 5xx is read again until the deadline; any other refusal ends it.
        if (polled.status === 200) record = polled.body;
        else if (polled.status >= 400 && polled.status < 500 && polled.status !== 429) return { ...failure(polled.status, polled.body), runId };
      }
    },
  };
}

/** `answer` as the model reads it: JSON, cut at CLIP characters, the whole then filed in the run's evidence/monid/
 *  through its Workspace (by run id, else by `label` and the time) and the cut saying where. A copy that cannot be filed
 *  (a full disk, a link in the way, which the Workspace never writes through) still answers, cut and saying so: the
 *  answer may have been paid for. */
export async function monidText(answer: MonidAnswer, work: Workspace, label: string): Promise<string> {
  const text = JSON.stringify(answer);
  if (text.length <= CLIP) return text;
  const runId = typeof answer.runId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(answer.runId) ? answer.runId : undefined;
  const name = `${runId ?? `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`}.json`;
  const cut = `${text.slice(0, CLIP)}\n[cut at ${CLIP} of ${text.length} characters; `;
  try {
    await work.write(`evidence/monid/${name}`, text);
  } catch (error) {
    // The Workspace's code and the port's line for it, never the error's message, which names paths.
    return `${cut}the whole answer could not be saved (${workspaceErrorWords(error) ?? (error as { code?: string })?.code ?? "write failed"})]`;
  }
  return `${cut}the whole answer is in the run's files at evidence/monid/${name}]`;
}

/** One pinned endpoint, as monid listed it at the save: what its tool says, the JSON Schema of its input
 *  (`{ pathParams?, queryParams?, body? }`, as POST /v1/run takes it), and what one call is held at in USD: its fixed
 *  price, or the usage ceiling when `usage` (monid prices it by what it returns). */
export type MonidPinned = MonidPin[string];
/** A revision's monid pin: each granted endpoint by its catalog name, `monid:<provider>/<endpoint>`. */
export type MonidPin = MonidPinBody;

/** The fixed USD price of one call priced `price` (monid's listing): a per-call amount; the dearest variant of a matrix
 *  of fixed prices; a tiered price's default and every tier added up (tiers add, so all of them is the most one call
 *  can be charged). Undefined for a price by usage, or one in another currency. */
function fixedUsd(price: unknown): number | undefined {
  if (!isObject(price)) return undefined;
  const of = (parts: readonly unknown[]) => (parts.every((part) => fixedUsd(part) !== undefined) ? parts.map((part) => fixedUsd(part)!) : undefined);
  if (price.type === "PER_CALL") {
    const amount = money(price.amount);
    return amount?.currency === "USD" && amount.value >= 0 ? amount.value : undefined;
  }
  const variants = Array.isArray(price.variants) ? of(price.variants.map((variant) => (isObject(variant) ? variant.price : undefined))) : undefined;
  if (price.type === "PER_UNIT_MATRIX") return variants?.length ? Math.max(...variants) : undefined;
  if (price.type === "TIERED" && Array.isArray(price.tiers)) {
    const parts = of([...(price.default === undefined ? [] : [price.default]), ...price.tiers.map((tier) => (isObject(tier) ? tier.price : undefined))]);
    return parts?.reduce((sum, usd) => sum + usd, 0);
  }
  return undefined;
}

/** What one call of an endpoint priced `price` is held at: its fixed price (fixedUsd), else the usage ceiling. */
export const heldOf = (price: unknown): { usd: number; usage?: true } => {
  const usd = fixedUsd(price);
  return usd === undefined ? { usd: MONID_USAGE_CEILING_USD, usage: true } : { usd };
};

/** `schema` moved from a document's root to the JSON pointer `at`: each local reference to a place in it (`#`, `#/…`)
 *  rebased onto `at`, so `#/$defs/Person` reads `#/properties/body/$defs/Person`. A schema with its own `$id` is a
 *  resource of its own, whose local references resolve inside it: it and all under it are left as they are. */
const rebased = (schema: unknown, at: string): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => rebased(item, at));
  if (!isObject(schema) || typeof schema.$id === "string") return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/")) ? `#${at}${value.slice(1)}` : rebased(value, at)]));
};

/** An endpoint's input schema as one tool's (inspect's `input`: `pathParams`, `queryParams`, `body`, each a JSON
 *  Schema): an object of those parts, each required that requires a field, its local references rebased. */
function inputSchema(input: unknown): Json {
  const parts = isObject(input) ? input : {};
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const part of ["pathParams", "queryParams", "body"]) {
    if (!isObject(parts[part])) continue;
    const { $schema: _schema, ...schema } = rebased(parts[part], `/properties/${part}`) as Json;
    properties[part] = schema;
    if (Array.isArray(schema.required) && schema.required.length) required.push(part);
  }
  return { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

/** Why a save's monid grants cannot be pinned, each by its grant; or the pin. */
export type MonidPinOutcome = { pin: MonidPin } | { refused: { tool: string; message: string }[] };

/** The monid grants among `grants` pinned against monid's listing on `key` (pinned at a save, never at a run): each
 *  provider's wildcard read as the endpoints monid lists for it now (at most MONID_WILDCARD_MAX), each endpoint inspected
 *  for its description, input and price. A grant monid lists nothing for is refused, as is every grant when there is no
 *  key or monid cannot be read. Undefined when no grant is monid's. */
export async function pinMonid(grants: readonly string[], options: { key: string | undefined; fetch?: typeof fetch; signal?: AbortSignal; sleep?: MonidOptions["sleep"] }): Promise<MonidPinOutcome | undefined> {
  const named = grants.flatMap((tool) => {
    const parsed = parseToolName(tool);
    return parsed?.kind === "monid" || parsed?.kind === "monid-provider" ? [{ tool, parsed }] : [];
  });
  if (!named.length) return undefined;
  if (!options.key) return { refused: named.map(({ tool }) => ({ tool, message: `${tool} is pinned to what monid lists when the agent is saved, and there is no monid key here to read it with: save the monid key in Settings → Tool keys first.` })) };
  const client = monidClient({ key: options.key, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
  // monid's own words, which a save's refusal returns to its caller: the key they were read with cut from them, in
  // every form a run's error is redacted of (key-refusal.ts redacted).
  const key = options.key;
  const said = (error: unknown) => redacted(String(error), [key]);
  const refused: { tool: string; message: string }[] = [];
  // Each endpoint to pin, by catalog name: the grants' own, then each wildcard's provider's as monid lists them.
  const wanted = new Map<string, { provider: string; endpoint: string }>();
  const providers = new Set(named.flatMap(({ parsed }) => (parsed.kind === "monid-provider" ? [parsed.provider] : [])));
  if (providers.size) {
    const listed = new Map<string, string[]>();
    // Every page, a bounded number of them: monid's listing is not filtered by provider.
    for (let cursor: string | undefined, page = 0; (page === 0 || cursor) && page < 500; page++) {
      const res = await client.endpoints(cursor, options.signal);
      if (res.error !== undefined) return { refused: named.map(({ tool }) => ({ tool, message: `${tool} could not be pinned: monid's listing could not be read (${said(res.error)}).` })) };
      for (const item of Array.isArray(res.items) ? res.items : []) {
        if (isObject(item) && typeof item.provider === "string" && typeof item.endpoint === "string" && providers.has(item.provider)) listed.set(item.provider, [...(listed.get(item.provider) ?? []), item.endpoint]);
      }
      cursor = typeof res.cursor === "string" && res.cursor ? res.cursor : undefined;
    }
    for (const { tool, parsed } of named) {
      if (parsed.kind !== "monid-provider") continue;
      const endpoints = listed.get(parsed.provider) ?? [];
      if (!endpoints.length) refused.push({ tool, message: `monid lists no endpoint of a provider ${parsed.provider}.` });
      else if (endpoints.length > MONID_WILDCARD_MAX) refused.push({ tool, message: `monid lists ${endpoints.length} endpoints of ${parsed.provider}, more than the ${MONID_WILDCARD_MAX} one grant may pin: grant its endpoints by name, monid:${parsed.provider}/<endpoint>.` });
      else for (const path of endpoints) wanted.set(formatToolName({ kind: "monid", provider: parsed.provider, endpoint: path.replace(/^\//, "") }), { provider: parsed.provider, endpoint: path });
    }
  }
  for (const { tool, parsed } of named) if (parsed.kind === "monid") wanted.set(tool, { provider: parsed.provider, endpoint: `/${parsed.endpoint}` });
  // Each endpoint inspected, INSPECTS_AT_ONCE at a time.
  const pin: Record<string, MonidPinned> = {};
  const queue = [...wanted];
  const inspectOne = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [tool, at] = next;
      const res = await client.inspect(at, options.signal);
      if (res.status === 404) refused.push({ tool, message: `monid lists no endpoint ${at.endpoint} of a provider ${at.provider}.` });
      else if (res.error !== undefined) refused.push({ tool, message: `${tool} could not be pinned: monid's listing of it could not be read (${said(res.error)}).` });
      else pin[tool] = { description: [res.description, res.summary].find((said): said is string => typeof said === "string" && said.trim() !== "")?.trim() ?? `${at.provider} ${at.endpoint}, an endpoint of monid's.`, input: inputSchema(res.input), ...heldOf(res.price) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(INSPECTS_AT_ONCE, queue.length) }, inspectOne));
  // Two endpoints the harnesses would call by one name (wireName folds `.` and `/`): neither could be told apart.
  const wires = new Map<string, string>();
  for (const tool of Object.keys(pin).sort()) {
    const other = wires.get(wireName(tool));
    if (other) refused.push({ tool, message: `${tool} and ${other} are called by one name on every harness (${wireName(tool)}): grant one of them by name.` });
    wires.set(wireName(tool), tool);
  }
  return refused.length ? { refused } : { pin: Object.fromEntries(Object.keys(pin).sort().map((tool) => [tool, pin[tool]!])) };
}
