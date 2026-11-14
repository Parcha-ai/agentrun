// Under `faux` only (startServe's `fauxMonid`): the fetch the monid tools send through, in place of monid's API (the tests'
// fake). It answers only the tests' key (KEY, or the one whose SHA-256 AGENTRUN_TEST_FAUX_MONID_ACCEPTS holds: a digest, so
// no key is in the run's environment, and a name the key rule leaves there), files one line per call
// (with the process that made it, and a digest of the key it came on) in the file AGENTRUN_TEST_FAUX_MONID_CALLS names,
// and keeps each call in `calls` for a test that calls it in its own process. It lists LISTING (GET /v1/endpoints, paged)
// and inspects only what it lists (404 otherwise). Its endpoints, by path: /person/enrich answers at once; /tweets answers 202 and completes on its second read; /slow never
// ends until stopped; /wallet is 402; /budget is BLOCKED; /broken FAILS; /late is a sync 408; /missing is the provider's
// 404; /huge answers more than the model reads; /person/search is priced per result and charges $1.42; /person/lookup
// is $1 a call. A run sent with a maxCost below its estimate is refused as monid refuses it (400 MAX_COST_EXCEEDED). With AGENTRUN_TEST_FAUX_MONID_DOWN set, every call is filed and then
// fails as a fetch to a host that can't be reached does; with AGENTRUN_TEST_FAUX_MONID_STATUS, it answers that status;
// with AGENTRUN_TEST_FAUX_MONID_STALL, it is held, its signal ignored as a provider answering late, until release(), and
// stalled() gives the held call's signal once one is held.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

/** The key the tests set: plainly fake, and never shaped like a real one on a Bearer line. */
export const KEY = ["monid", "live", "not-a-secret"].join("_");
export const calls = [];
const runs = new Map();
let next = 0;
const held = [];
const waiting = [];
/** Once a call is held (AGENTRUN_TEST_FAUX_MONID_STALL): the signal it was sent with. */
export const stalled = () => new Promise((reached) => (held.length ? reached(held[0].signal) : waiting.push(reached)));
/** Every held call goes on, and is answered as any other. */
export const release = () => { for (const { go } of held.splice(0)) go(); };

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PRICE = { type: "PER_CALL", amount: { value: 0.003, currency: "USD" } };
const done = (runId, endpoint, output) => ({ runId, provider: "faux", endpoint, status: "COMPLETED", output, providerResponse: { httpStatus: 200 }, price: PRICE, billedUnits: 1 });
/** monid's listing as the fake gives it (GET /v1/endpoints, two to a page so a wildcard's read pages): faux's endpoints
 *  at PRICE, and apollo's, /people/match at $0.026 a call, /organizations/enrich at $0.01 and /news_articles/search
 *  priced per result (by usage). */
export const LISTING = [
  ...["/person/enrich", "/tweets", "/slow", "/wallet", "/budget", "/broken", "/late", "/missing", "/huge"].map((endpoint) => ({ provider: "faux", endpoint, price: PRICE })),
  { provider: "apollo", endpoint: "/people/match", price: { type: "PER_CALL", amount: { value: 0.026, currency: "USD" } } },
  { provider: "apollo", endpoint: "/organizations/enrich", price: { type: "PER_CALL", amount: { value: 0.01, currency: "USD" } } },
  { provider: "apollo", endpoint: "/news_articles/search", price: { type: "PER_RESULT", amount: { value: 0.001, currency: "USD" } } },
  // Priced by usage (per result): monid estimates one result ($0.001), and a call charges $1.42, as a real one asked for
  // 100 rows does. Nothing about the call bounds what it is charged.
  { provider: "faux", endpoint: "/person/search", price: { type: "PER_RESULT", amount: { value: 0.001, currency: "USD" } } },
  // Priced per result and per credit: a provider whose every endpoint is priced by usage.
  { provider: "metered", endpoint: "/rows", price: { type: "PER_UNIT", amount: { value: 0.002, currency: "USD" }, per: 1, unit: "credit" } },
  // A dear endpoint at a fixed price ($1 a call), charged its price: a call a small cap refuses.
  { provider: "faux", endpoint: "/person/lookup", price: { type: "PER_CALL", amount: { value: 1, currency: "USD" } } },
  // Its body's schema holds patternProperties, which Codex refuses (TAGGED_INPUT).
  { provider: "tagger", endpoint: "/tag", price: PRICE },
];
/** tagger /tag's input: a body of tags by any name, as patternProperties (a shape Codex refuses, schema.ts). */
const TAGGED_INPUT = { body: { type: "object", patternProperties: { "^[a-z]+$": { type: "string" } } } };
const PAGE = 2;

export default async function fakeMonid(url, init = {}) {
  const path = new URL(String(url)).pathname;
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const bearer = new Headers(init.headers).get("authorization") ?? "";
  const given = bearer.replace(/^Bearer /, "");
  const accepts = process.env.AGENTRUN_TEST_FAUX_MONID_ACCEPTS;
  const authorized = bearer === `Bearer ${KEY}` || (Boolean(accepts) && bearer.startsWith("Bearer ") && createHash("sha256").update(given).digest("hex") === accepts);
  const key = createHash("sha256").update(bearer.replace(/^Bearer /, "")).digest("hex").slice(0, 16);
  calls.push({ method, path, body, authorized });
  if (process.env.AGENTRUN_TEST_FAUX_MONID_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_MONID_CALLS, `${JSON.stringify({ pid: process.pid, method, path, authorized, key, ...(body?.endpoint ? { endpoint: body.endpoint } : {}), ...(body?.maxCost !== undefined ? { maxCost: body.maxCost } : {}) })}\n`);
  if (process.env.AGENTRUN_TEST_FAUX_MONID_STALL) await new Promise((go) => { held.push({ go, signal: init.signal }); for (const reached of waiting.splice(0)) reached(init.signal); });
  // A vendor that echoes the key it was sent in an error (the secrets harness's planted stored key): on the one path
  // AGENTRUN_TEST_FAUX_MONID_ECHO names, a 400 whose message holds the key whole.
  if (process.env.AGENTRUN_TEST_FAUX_MONID_ECHO && path === process.env.AGENTRUN_TEST_FAUX_MONID_ECHO) return json(400, { code: 400, message: `No such endpoint for the key ${given}` });
  if (process.env.AGENTRUN_TEST_FAUX_MONID_STATUS) return json(Number(process.env.AGENTRUN_TEST_FAUX_MONID_STATUS), { code: Number(process.env.AGENTRUN_TEST_FAUX_MONID_STATUS), message: "This key may not use this endpoint." });
  if (process.env.AGENTRUN_TEST_FAUX_MONID_DOWN) throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.monid.ai"), { code: "ENOTFOUND" }) });
  if (!authorized) return json(401, { code: 401, message: "Missing or invalid API key" });
  if (path === "/v1/discover") {
    const results = Array.from({ length: Math.min(body.limit ?? 5, 40) }, (_, i) => ({ provider: "faux", endpoint: i ? `/other/${i}` : "/person/enrich", description: body.query.includes("everything") ? "x".repeat(20_000) : "Enrich a person from a name and company.", score: 0.9 - i / 100, price: PRICE }));
    return json(200, { results, query: body.query, count: results.length });
  }
  if (path === "/v1/endpoints") {
    const from = Number(new URL(String(url)).searchParams.get("cursor") ?? 0);
    const items = LISTING.slice(from, from + PAGE).map(({ provider, endpoint, price }) => ({ provider, endpoint, displayName: endpoint, price }));
    return json(200, { items, total: LISTING.length, ...(from + PAGE < LISTING.length ? { cursor: String(from + PAGE) } : {}) });
  }
  if (path === "/v1/inspect") {
    const listed = LISTING.find((one) => one.provider === body.provider && one.endpoint === body.endpoint);
    if (!listed) return json(404, { code: 404, message: `Endpoint '${body.endpoint}' not found for provider '${body.provider}'` });
    return json(200, { id: "insp-1", provider: body.provider, endpoint: body.endpoint, description: `${body.provider} ${body.endpoint}: enrich a person.`, input: body.provider === "tagger" ? TAGGED_INPUT : { body: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["name"], properties: { name: { type: "string" } } } }, price: listed.price, tags: ["verified"] });
  }
  const run = /^\/v1\/runs\/([^/]+)(\/stop)?$/.exec(path);
  if (run) {
    const held = runs.get(run[1]);
    if (!held) return json(404, { code: 404, message: "Run not found" });
    if (run[2]) return (held.status = "STOPPED", json(202, { runId: run[1], status: "STOPPING", message: "Stop requested" }));
    held.reads++;
    if (held.endpoint === "/tweets" && held.reads >= 2) return json(200, { ...done(run[1], held.endpoint, [{ text: "a tweet" }]), cost: { value: 0.012, currency: "USD" } });
    if (held.endpoint === "/broken" && held.reads >= 2) held.status = "FAILED";
    return json(200, { runId: run[1], provider: "faux", endpoint: held.endpoint, status: held.status, price: PRICE });
  }
  if (path !== "/v1/run") return json(404, { code: 404, message: "Not found" });
  // monid's maxCost: a run whose estimate is above it is refused as sent (400 MAX_COST_EXCEEDED), never run nor charged.
  // The estimate is the listed amount: a fixed price exactly; one result of an endpoint priced per result, which the
  // call's charge may pass.
  const estimate = LISTING.find((one) => one.provider === body.provider && one.endpoint === body.endpoint)?.price.amount?.value ?? 0;
  if (typeof body.maxCost === "number" && estimate > body.maxCost) return json(400, { code: 400, errorCode: "MAX_COST_EXCEEDED", message: `Run not started: estimated cost ~$${estimate} is above maxCost $${body.maxCost}. Raise maxCost to at least ${estimate} or choose a cheaper endpoint.` });
  const runId = `run${String(++next).padStart(4, "0")}`;
  switch (body.endpoint) {
    case "/person/enrich": return json(200, { ...done(runId, body.endpoint, { full_name: body.input?.body?.name ?? null }), billing: { reportedCost: { value: 3000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/tweets": case "/slow": case "/broken": return (runs.set(runId, { endpoint: body.endpoint, status: "RUNNING", reads: 0 }), json(202, { runId, provider: "faux", endpoint: body.endpoint, status: "READY", price: PRICE }));
    case "/wallet": return json(402, { code: 402, message: "Payment required: insufficient wallet balance" });
    case "/budget": return json(200, { runId, status: "BLOCKED", reason: "The workspace's monthly budget is spent.", controls: [{ type: "BUDGET" }] });
    case "/late": return json(408, { runId, status: "TIMED_OUT" });
    case "/missing": return json(404, { runId, status: "COMPLETED", output: null, providerResponse: { httpStatus: 404, error: { status: 404, message: "No match found for the given query" } }, billing: { reportedCost: { value: 0, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/huge": return json(200, done(runId, body.endpoint, "y".repeat(100_000)));
    case "/people/match": return json(200, { ...done(runId, body.endpoint, { person: body.input?.body?.name ?? null }), provider: "apollo", billing: { reportedCost: { value: 26000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/person/search": return json(200, { ...done(runId, body.endpoint, [{ full_name: body.input?.body?.name ?? null }]), billing: { reportedCost: { value: 1_420_000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/person/lookup": return json(200, { ...done(runId, body.endpoint, { full_name: body.input?.body?.name ?? null }), billing: { reportedCost: { value: 1_000_000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/organizations/enrich": return json(200, { ...done(runId, body.endpoint, { organization: body.input?.body?.name ?? null }), provider: "apollo", billing: { reportedCost: { value: 10000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/news_articles/search": return json(200, { ...done(runId, body.endpoint, [{ title: "news" }]), provider: "apollo", billing: { reportedCost: { value: 4000, unit: "MICRO_DOLLAR", currency: "USD" } } });
  }
  return json(404, { code: 404, message: `No endpoint ${body.endpoint}` });
}
