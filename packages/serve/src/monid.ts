// monid (monid.ai): one key, and a listing of paid data endpoints from many providers. An agent is granted endpoints by
// name, `monid:<provider>/<endpoint>` or a provider's `monid:<provider>/*` (tool-names.ts), and each granted endpoint is
// one tool of its own, on every harness: its description, input and price as monid listed them when the agent was saved.
//
// At the save (server.ts saveable, the one check of a create, an edit and an inline run): each grant is read against
// monid's listing (a provider's wildcard: every endpoint it lists, GET /v1/endpoints; one endpoint: POST /v1/inspect),
// and the pin (MonidPinBody) is stamped on the revision beside its MCP pin. A grant the agent's current revision made too
// is carried from its pin, nothing read. A grant monid does not list is refused in words, so is one that
// cannot be read now (no key, monid unreachable). A run reads its revision's pin and never monid's listing.
//
// An endpoint priced by usage (per result, per unit, metered, a matrix or tier with a usage part) is pinned too, with no
// fixed price, and the save's warnings name it (usageWords): monid can't cap what such a call charges. Its maxCost
// checks only monid's estimate, which such a call can pass (monid's API reference, POST /v1/run). Which endpoints an
// agent may call is the control: named grants, a provider's wildcard, and deny or ask per tool.
//
// At a run (runner/monid-run.ts): each pinned endpoint is one host tool, by its catalog name (its wire name on the
// harness, catalog.ts wireName). The gate asks about it by that name, its card shows what it is held at, and a call is a
// paid step on the run's one ledger (paid-calls.ts paidStep) named by it: held before it is sent, at its pinned price,
// or for one priced by usage at monid's estimate for the call's own input (estimateOf); refused unsent unless that fits
// the cap with what the run has spent and holds, then settled once at what monid says it charged, else at its hold
// unless monid says it charged nothing. It is sent with its hold as maxCost: monid refuses it unrun when its estimate is
// above it, so a fixed-price call is never charged past what it was held at. A call priced by usage can be; its charge
// is booked as charged, and the run stops at once.
//
// A run is sent once and never again: it spends money, and a request that failed after it left may have run. An async
// provider answers 202 with a run id, read again every POLL_MS until it ends, for at most WAIT_MS in all; a run the
// caller stops, or one that outlasts the wait, is asked to stop. Every answer reaches the model as JSON, cut at CLIP
// characters, the whole of it then filed under the run's work/evidence/monid/.
import { randomUUID } from "node:crypto";
import { type Workspace, workspaceErrorWords } from "./workspace/index.js";
import { wireName } from "./catalog.js";
import { formatToolName, monidNameOf, parseToolName, type ToolName } from "./tool-names.js";
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
/** The most endpoints one provider's wildcard pins: a provider that lists more is granted endpoint by endpoint. */
const MONID_WILDCARD_MAX = 50;
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
export const uncharged = (answer: MonidAnswer): MonidAnswer => Object.assign(answer, { [UNCHARGED]: true });
/** On a run monid refused unrun because its estimate is above the maxCost it was sent with (400 MAX_COST_EXCEEDED): that
 *  estimate in USD, as monid's message names it ("Raise maxCost to at least 0.01212"). A symbol, as UNCHARGED. */
const ESTIMATE = Symbol("monid.estimate");
/** The estimate monid named refusing `answer` for its maxCost; undefined for any other answer. */
export const estimateOf = (answer: MonidAnswer): number | undefined => (answer as { [ESTIMATE]?: number })[ESTIMATE];
/** The estimate in monid's MAX_COST_EXCEEDED words, in USD: the least maxCost it would run at, else its "~$" figure. */
const namedEstimate = (body: Json): number | undefined => {
  if (body.errorCode !== "MAX_COST_EXCEEDED" || typeof body.message !== "string") return undefined;
  const said = /at least \$?(\d+(?:\.\d+)?)/.exec(body.message)?.[1] ?? /estimated cost ~\$(\d+(?:\.\d+)?)/.exec(body.message)?.[1];
  const usd = said === undefined ? NaN : Number(said);
  return Number.isFinite(usd) && usd >= 0 ? usd : undefined;
};
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
const costOf = (record: Json) => money(record.cost) ?? money(isObject(record.billing) ? record.billing.reportedCost : undefined);

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
    /** One run, `maxCost` its most in USD when given: monid refuses a run whose estimate is above it, unrun and
     *  uncharged (400 MAX_COST_EXCEEDED), naming the estimate (estimateOf); so maxCost 0 reads the estimate of a run
     *  that is not free, and runs one monid estimates at $0. It is sent in whole micro-dollars (monid takes at most 6
     *  decimals), rounded down, so it never allows more than given. */
    async run(args: { provider: string; endpoint: string; input?: Json; maxCost?: number }, signal?: AbortSignal): Promise<MonidAnswer> {
      const deadline = Date.now() + waitMs;
      const maxCost = args.maxCost === undefined ? {} : { maxCost: Math.floor(args.maxCost * 1e6 + 1e-6) / 1e6 };
      const first = await call("POST", "/v1/run", { provider: args.provider, endpoint: args.endpoint, input: args.input ?? {}, ...maxCost }, signal, waitMs);
      if (first.status === 0) return { error: `${first.body.message}: the run may have gone ahead at monid, and is not sent again` };
      if (first.status !== 202 || typeof first.body.runId !== "string") {
        const answered = outcome(first.status, first.body);
        const estimate = first.status === 400 ? namedEstimate(first.body) : undefined;
        return estimate === undefined ? answered : Object.assign(answered, { [ESTIMATE]: estimate });
      }
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

/** The fixed USD price of one call priced `price` (monid's listing): a per-call amount; the dearest variant of a matrix
 *  of fixed prices; a tiered price's default and every tier added up (tiers add, so all of them is the most one call
 *  can be charged): what one call is held at, sent with it as its maxCost. Undefined for a price by usage, whose call is
 *  held at monid's estimate for its input, or one in another currency. */
export function fixedUsd(price: unknown): number | undefined {
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

/** The reason of a save's warning (usageWords). */
export const PRICED_BY_USAGE = "priced_by_usage";
/** The save's warning for the endpoint `tool`, priced by usage (no fixed USD price: fixedUsd is undefined). */
export const usageWords = (tool: string) =>
  `${tool} is priced by usage: monid can't cap what it charges, so a call can cost more than its estimate and more than the run's cap allows.`;

/** `schema` moved from a document's root to the JSON pointer `at`: each local reference to a place in it (`#`, `#/…`)
 *  rebased onto `at`, so `#/$defs/Person` reads `#/properties/body/$defs/Person`. A schema with its own `$id` is a
 *  resource of its own, whose local references resolve inside it: it and all under it are left as they are. A keyword
 *  whose value is data (VALUE_KEYWORDS: `const`, `enum`, ...) is left as it is, a `$ref` in it being part of a value the
 *  endpoint takes; under a keyword that maps names to schemas (NAMED_SCHEMAS: `properties`, `$defs`, ...), each name is
 *  a name, never a keyword, and each schema under it is walked. */
const rebased = (schema: unknown, at: string): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => rebased(item, at));
  if (!isObject(schema) || typeof schema.$id === "string") return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) return [key, `#${at}${value.slice(1)}`];
    if (VALUE_KEYWORDS.has(key)) return [key, value];
    if (NAMED_SCHEMAS.has(key) && isObject(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, rebased(sub, at)]))];
    return [key, rebased(value, at)];
  }));
};
/** JSON Schema keywords whose value is data, not a schema. */
const VALUE_KEYWORDS = new Set(["const", "enum", "default", "examples", "example"]);
/** JSON Schema keywords whose value maps names to schemas. */
const NAMED_SCHEMAS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

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

/** Why a save's monid grants cannot be pinned, each by its grant; or the pin, with a warning for each endpoint priced by
 *  usage it holds (`warnings`, by the grant that named it or its wildcard: the save's warnings). */
type MonidPinOutcome = { pin: MonidPinBody; warnings: { tool: string; message: string }[] } | { refused: { tool: string; message: string }[] };

/** The monid grants among `grants` pinned against monid's listing on `key` (pinned at a save, never at a run): each
 *  provider's wildcard read as the endpoints monid lists for it now (at most MONID_WILDCARD_MAX), each endpoint inspected
 *  for its description, input and price. A grant the `previous` revision made too is carried from its pin, nothing read
 *  for it, as an MCP server's listing is (server.ts mcpListingOf). A grant monid lists nothing for is refused, as is every
 *  grant to read when there is no key or monid cannot be read. An endpoint with no fixed price (fixedUsd) is pinned with
 *  none, and warned of (usageWords). Undefined when no grant is monid's. */
export async function pinMonid(grants: readonly string[], options: { key: string | undefined; fetch?: typeof fetch; signal?: AbortSignal; sleep?: MonidOptions["sleep"]; previous?: { grants: readonly string[]; pin: MonidPinBody | null } }): Promise<MonidPinOutcome | undefined> {
  const pin: Record<string, MonidPinBody[string]> = {};
  const before = options.previous;
  const named = grants.flatMap((tool) => {
    const parsed = parseToolName(tool);
    if (parsed?.kind !== "monid" && parsed?.kind !== "monid-provider") return [];
    // Carried: each endpoint the previous pin holds under this grant (the gate's keys, as the run's tools are read).
    const kept = before?.grants.includes(tool) ? Object.entries(before.pin ?? {}).filter(([endpoint]) => endpoint === tool || (parsed.kind === "monid-provider" && monidNameOf(endpoint)?.provider === parsed.provider)) : [];
    for (const [endpoint, one] of kept) pin[endpoint] = one;
    return [{ tool, parsed, read: !kept.length }];
  });
  if (!named.length) return undefined;
  const reads = named.filter((grant) => grant.read);
  if (reads.length && !options.key) return { refused: reads.map(({ tool }) => ({ tool, message: `${tool} is pinned to what monid lists when the agent is saved, and there is no monid key here to read it with: save the monid key in Settings → Tool keys first.` })) };
  const refused = reads.length ? await readPins(reads, pin, { ...options, key: options.key! }) : [];
  // Two endpoints the harnesses would call by one name (wireName folds `.` and `/`): neither could be told apart.
  const wires = new Map<string, string>();
  for (const tool of Object.keys(pin).sort()) {
    const other = wires.get(wireName(tool));
    if (other) refused.push({ tool, message: `${tool} and ${other} are called by one name on every harness (${wireName(tool)}): grant one of them by name.` });
    wires.set(wireName(tool), tool);
  }
  if (refused.length) return { refused };
  const endpoints = Object.keys(pin).sort();
  // An endpoint priced by usage, said at the grant that names it, else at its provider's wildcard.
  const grantOf = (endpoint: string) => (grants.includes(endpoint) ? endpoint : `monid:${monidNameOf(endpoint)!.provider}/*`);
  return { pin: Object.fromEntries(endpoints.map((tool) => [tool, pin[tool]!])), warnings: endpoints.filter((tool) => pin[tool]!.usd === null).map((tool) => ({ tool: grantOf(tool), message: usageWords(tool) })) };
}

/** The grants `reads` read against monid's listing into `pin`; why each that could not be is refused. */
async function readPins(named: readonly { tool: string; parsed: ToolName }[], pin: Record<string, MonidPinBody[string]>, options: { key: string; fetch?: typeof fetch; signal?: AbortSignal; sleep?: MonidOptions["sleep"] }): Promise<{ tool: string; message: string }[]> {
  const client = monidClient({ key: options.key, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
  // monid's own words, which a save's refusal returns to its caller: the key they were read with cut from them, in
  // every form a run's error is redacted of (key-refusal.ts redacted).
  const key = options.key;
  const said = (error: unknown) => redacted(String(error), [key]);
  const refused: { tool: string; message: string }[] = [];
  // Each endpoint to pin, by catalog name: each wildcard's provider's as monid lists them, then the grants' own.
  const wanted = new Map<string, { provider: string; endpoint: string }>();
  const providers = new Set(named.flatMap(({ parsed }) => (parsed.kind === "monid-provider" ? [parsed.provider] : [])));
  if (providers.size) {
    const listed = new Map<string, string[]>();
    // Every page, a bounded number of them: monid's listing is not filtered by provider.
    for (let cursor: string | undefined, page = 0; (page === 0 || cursor) && page < 500; page++) {
      const res = await client.endpoints(cursor, options.signal);
      if (res.error !== undefined) return named.map(({ tool }) => ({ tool, message: `${tool} could not be pinned: monid's listing could not be read (${said(res.error)}).` }));
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
  const queue = [...wanted];
  const inspectOne = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [tool, at] = next;
      const res = await client.inspect(at, options.signal);
      if (res.status === 404) refused.push({ tool, message: `monid lists no endpoint ${at.endpoint} of a provider ${at.provider}.` });
      else if (res.error !== undefined) refused.push({ tool, message: `${tool} could not be pinned: monid's listing of it could not be read (${said(res.error)}).` });
      else pin[tool] = { description: [res.description, res.summary].find((said): said is string => typeof said === "string" && said.trim() !== "")?.trim() ?? `${at.provider} ${at.endpoint}, an endpoint of monid's.`, input: inputSchema(res.input), usd: fixedUsd(res.price) ?? null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(INSPECTS_AT_ONCE, queue.length) }, inspectOne));
  return refused;
}
