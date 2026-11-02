// monid (monid.ai): one key, and a catalog of paid data endpoints from many providers behind three calls. An agent finds
// an endpoint in plain words (discover), reads its input schemas and price (inspect), and runs it (run), paid per call
// from the key's workspace wallet. Three table tools here (tools.ts), on pi only; pi registers each under its wire name
// (catalog.ts: `monid.run` is `monid_run`), as a model API takes no dot in a tool's name.
//
// A run is sent once and never again: it spends money, and a request that failed after it left may have run. An async
// provider answers 202 with a run id, read again every POLL_MS until it ends, for at most WAIT_MS in all; a run the
// caller stops, or one that outlasts the wait, is asked to stop. Every answer reaches the model as JSON, cut at CLIP
// characters, the whole of it then filed under the run's work/evidence/monid/.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { wireName } from "./catalog.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";
import type { ToolEntry } from "./tools.js";
import { isObject, type Json } from "./validate.js";

export const MONID_KEY_ENV = "MONID_API_KEY";
/** Under `faux` only (startServe's `fauxMonid`): a module whose default export is the fetch monid's calls go through, in
 *  place of monid's API (the tests' fake). */
export const FAUX_MONID_ENV = "AGENTRUN_SERVE_FAUX_MONID";
export const MONID_API = "https://api.monid.ai";
/** The most characters of one answer the model reads. */
export const CLIP = 60_000;
const TERMINAL = ["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"];
/** The shortest limit a read of a run gets near the deadline: it outlives the deadline by this much at most. */
const MIN_READ_MS = 100;

/** monid's answer, or `error` saying why there is none, with the HTTP `status` when one came. */
export type MonidAnswer = Json & { error?: string };
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
    return { error: `the provider answered ${code}: ${said} (monid charges nothing for a provider's error)`, status: code, ...at };
  }
  if (state === "COMPLETED") return { ...record, ...at };
  if (state === "BLOCKED") return { error: `a control gate of the monid workspace, such as its budget, refused the run (BLOCKED): ${typeof record.reason === "string" ? record.reason : "no reason given"}`, ...(record.controls !== undefined ? { controls: record.controls } : {}), ...at };
  if (state === "FAILED") return { error: "the run failed inside monid (FAILED); it is not sent again", ...at };
  if (state === "TIMED_OUT") return { error: "the run went past monid's time budget (TIMED_OUT)", status: 408, ...at };
  if (state === "STOPPED") return { error: "the run was stopped before it completed (STOPPED); a stopped run is not billed", ...at };
  return { ...failure(status, record), ...at };
}

/** monid's three calls on `key`, each answering what the model reads, never throwing. */
export function monidClient(options: MonidOptions) {
  const { key, requestMs = 30_000, pollMs = 2_000, waitMs = 150_000, sleep = pause } = options;
  const send = options.fetch ?? fetch;
  const call = async (method: string, path: string, body: Json | undefined, signal?: AbortSignal, ms = requestMs): Promise<{ status: number; body: Json }> => {
    const limit = AbortSignal.timeout(ms);
    try {
      const res = await send(`${MONID_API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, limit]) : limit });
      const text = await res.text();
      const json: unknown = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
      return { status: res.status, body: isObject(json) ? json : { message: text.slice(0, 500) } };
    } catch (error) {
      return { status: 0, body: { message: signal?.aborted ? "stopped by the caller" : limit.aborted ? `no answer in ${ms / 1000} s` : String((error as Error)?.message ?? error) } };
    }
  };
  const read = async (path: string, args: Json, signal?: AbortSignal): Promise<MonidAnswer> => {
    const res = await call("POST", path, args, signal);
    return res.status >= 200 && res.status < 300 ? res.body : failure(res.status, res.body);
  };
  const stop = async (runId: string, why: string): Promise<MonidAnswer> => {
    const res = await call("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`, undefined, undefined, 10_000);
    return { error: `the run ${why}; ${res.status === 202 ? "monid was asked to stop it" : `monid refused to stop it (${res.status || "no answer"})`}, and a metered endpoint bills what it used before the stop`, runId };
  };
  return {
    discover: (args: { query: string; limit?: number; minScore?: number }, signal?: AbortSignal) => read("/v1/discover", args, signal),
    inspect: (args: { provider: string; endpoint: string }, signal?: AbortSignal) => read("/v1/inspect", args, signal),
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

/** `answer` as the model reads it: JSON, cut at CLIP characters, the whole then filed under `work`'s evidence/monid/
 *  (by run id, else by `label` and the time) and the cut saying where. A copy that cannot be filed (a full disk) still
 *  answers, cut and saying so: the answer may have been paid for. */
export async function monidText(answer: MonidAnswer, work: string, label: string): Promise<string> {
  const text = JSON.stringify(answer);
  if (text.length <= CLIP) return text;
  const runId = typeof answer.runId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(answer.runId) ? answer.runId : undefined;
  const name = `${runId ?? `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`}.json`;
  const cut = `${text.slice(0, CLIP)}\n[cut at ${CLIP} of ${text.length} characters; `;
  try {
    await mkdir(join(work, "evidence", "monid"), { recursive: true });
    await writeFile(join(work, "evidence", "monid", name), text);
  } catch (error) {
    // The error's code only (ENOSPC, ENOTDIR): its message names the server's paths.
    return `${cut}the whole answer could not be saved (${(error as NodeJS.ErrnoException)?.code ?? "write failed"})]`;
  }
  return `${cut}the whole answer is in the run's files at evidence/monid/${name}]`;
}

type Kind = "discover" | "inspect" | "run";
const [DISCOVER, INSPECT, RUN] = (["discover", "inspect", "run"] as const).map((kind) => wireName(`monid.${kind}`));
const named = { provider: { type: "string", minLength: 1, description: `The provider's slug, as ${DISCOVER} gave it.` }, endpoint: { type: "string", minLength: 1, description: `The endpoint's path, as ${DISCOVER} gave it.` } };
const SPECS: Record<Kind, { summary: string; description: string; properties: Json; required: string[]; replay: "safe" | "unsafe" }> = {
  discover: {
    summary: "Search monid's catalog of paid data endpoints in plain words: { results: [{ provider, endpoint, description, score, price }] }.",
    description: `Search monid's catalog of paid data endpoints (people and company data, web and social media scrapers, search, and more, from many providers) with a plain-language query of what you need. Answers JSON: results, each a provider, an endpoint, what it does, a relevance score and its price. Next, ${INSPECT} the result that fits, then ${RUN} it.`,
    properties: { query: { type: "string", minLength: 1, maxLength: 1000, description: "What you need, in a short plain sentence." }, limit: { type: "integer", minimum: 1, maximum: 40, description: "How many results (default 5)." }, minScore: { type: "number", minimum: 0, maximum: 1, description: "The lowest relevance to keep (default 0.2)." } },
    required: ["query"], replay: "safe",
  },
  inspect: {
    summary: "One monid endpoint before it runs: the JSON Schemas of its input (path, query, body), its price, notes and documentation.",
    description: `Read one monid endpoint before you run it: the JSON Schemas of its input (pathParams, queryParams, body), its price, notes and documentation link. Then ${RUN} it with input that fits those schemas.`,
    properties: named, required: ["provider", "endpoint"], replay: "safe",
  },
  run: {
    summary: "Run one monid endpoint, paid per call from the monid wallet: its output, price and cost; a slow provider is waited for, about two minutes at most.",
    description: `Run one monid endpoint with its input, once ${INSPECT} has shown what it takes and what it costs. Each call is paid from the monid wallet: call it once per answer you need, never to retry a failure, which says why. Answers JSON: the run's output, its price and cost. A slow provider is waited for, about two minutes at most.`,
    properties: { ...named, input: { type: "object", description: `The endpoint's input as one object, shaped by the schemas ${INSPECT} gave; {} when it takes none.` } },
    required: ["provider", "endpoint"], replay: "unsafe",
  },
};

/** The table's entry for `monid.<kind>`: it needs MONID_API_KEY, and no workflow node names it yet. */
export const monidTool = (kind: Kind): ToolEntry => ({
  summary: SPECS[kind].summary,
  needs: [MONID_KEY_ENV],
  nodes: false,
  bind: async (host) => {
    const faux = host.env[FAUX_ENV] && host.env[FAUX_MONID_ENV] ? ((await import(pathToFileURL(host.env[FAUX_MONID_ENV]).href)) as { default: typeof fetch }).default : undefined;
    const client = monidClient({ key: host.env[MONID_KEY_ENV] ?? "", ...(faux ? { fetch: faux } : {}) });
    const { description, properties, required, replay } = SPECS[kind];
    const tool = defineTool({
      name: wireName(`monid.${kind}`), description, replay,
      parameters: { type: "object", additionalProperties: false, properties, required } as unknown as TSchema,
      execute: async (args, _api, context) => {
        const answer = await client[kind](args as never, context?.abortSignal);
        const cost = money(answer.cost);
        return forModel(await monidText(answer, host.where.work, kind), { isError: answer.error !== undefined, ...(cost ? { details: { cost } } : {}) });
      },
    }) as unknown as ToolRegistration;
    const extension = defineExtension({ name: `monid-${kind}`, tools: [tool] });
    host.install(extension);
    return { tools: [tool], extensions: [extension] };
  },
});
