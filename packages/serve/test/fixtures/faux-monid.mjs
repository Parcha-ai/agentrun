// Under `faux` only (startServe's `fauxMonid`): the fetch the monid tools send through, in place of monid's API (the tests'
// fake). It answers only the tests' key, files one line per call (with the process that made it) in the file
// AGENTRUN_TEST_FAUX_MONID_CALLS names, and keeps each call in `calls` for a test that calls it in its own process. Its
// endpoints, by path: /person/enrich answers at once; /tweets answers 202 and completes on its second read; /slow never
// ends until stopped; /wallet is 402; /budget is BLOCKED; /broken FAILS; /late is a sync 408; /missing is the provider's
// 404; /huge answers more than the model reads.
import { appendFileSync } from "node:fs";

/** The key the tests set: plainly fake, and never shaped like a real one on a Bearer line. */
export const KEY = ["monid", "live", "not-a-secret"].join("_");
export const calls = [];
const runs = new Map();
let next = 0;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PRICE = { type: "PER_CALL", amount: { value: 0.003, currency: "USD" } };
const done = (runId, endpoint, output) => ({ runId, provider: "faux", endpoint, status: "COMPLETED", output, providerResponse: { httpStatus: 200 }, price: PRICE, billedUnits: 1 });

export default async function fakeMonid(url, init = {}) {
  const path = new URL(String(url)).pathname;
  const method = init.method ?? "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  const authorized = new Headers(init.headers).get("authorization") === `Bearer ${KEY}`;
  calls.push({ method, path, body, authorized });
  if (process.env.AGENTRUN_TEST_FAUX_MONID_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_MONID_CALLS, `${JSON.stringify({ pid: process.pid, method, path, authorized })}\n`);
  if (!authorized) return json(401, { code: 401, message: "Missing or invalid API key" });
  if (path === "/v1/discover") {
    const results = Array.from({ length: Math.min(body.limit ?? 5, 40) }, (_, i) => ({ provider: "faux", endpoint: i ? `/other/${i}` : "/person/enrich", description: body.query.includes("everything") ? "x".repeat(20_000) : "Enrich a person from a name and company.", score: 0.9 - i / 100, price: PRICE }));
    return json(200, { results, query: body.query, count: results.length });
  }
  if (path === "/v1/inspect") return json(200, { id: "insp-1", provider: body.provider, endpoint: body.endpoint, description: "Enrich a person.", input: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } }, price: PRICE, tags: ["verified"] });
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
  const runId = `run${String(++next).padStart(4, "0")}`;
  switch (body.endpoint) {
    case "/person/enrich": return json(200, { ...done(runId, body.endpoint, { full_name: body.input.name ?? null }), billing: { reportedCost: { value: 3000, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/tweets": case "/slow": case "/broken": return (runs.set(runId, { endpoint: body.endpoint, status: "RUNNING", reads: 0 }), json(202, { runId, provider: "faux", endpoint: body.endpoint, status: "READY", price: PRICE }));
    case "/wallet": return json(402, { code: 402, message: "Payment required: insufficient wallet balance" });
    case "/budget": return json(200, { runId, status: "BLOCKED", reason: "The workspace's monthly budget is spent.", controls: [{ type: "BUDGET" }] });
    case "/late": return json(408, { runId, status: "TIMED_OUT" });
    case "/missing": return json(404, { runId, status: "COMPLETED", output: null, providerResponse: { httpStatus: 404, error: { status: 404, message: "No match found for the given query" } }, billing: { reportedCost: { value: 0, unit: "MICRO_DOLLAR", currency: "USD" } } });
    case "/huge": return json(200, done(runId, body.endpoint, "y".repeat(100_000)));
  }
  return json(404, { code: 404, message: `No endpoint ${body.endpoint}` });
}
