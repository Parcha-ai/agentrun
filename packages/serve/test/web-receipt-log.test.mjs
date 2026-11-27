// Each web_search and web_fetch call serve runs through its Web writes one web_receipt line to the server's log: the op,
// the provider that answered, each provider tried and how it went, what the classifier did (off, or ran with how many
// items it was given and kept, on which model) and what the call cost, so Jev's ranking in production can be audited
// from the log. Never a URL (so never its user name or password), never the page's text, the objective or a key.
// Parallel and Jev are the tests' fakes (fixtures/faux-parallel.mjs, fixtures/faux-jev-web.mjs); nothing leaves the
// machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CANARY as JEV_KEY } from "./fixtures/faux-jev-web.mjs";
import { CANARY as PARALLEL_KEY } from "./fixtures/faux-parallel.mjs";
import { toolLedger } from "./support.mjs";

const { searchFor } = await import("../dist/web-search.js");
const { webFetchTool } = await import("../dist/web-fetch.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { bookedIn } = await import("../dist/paid-calls.js");

const FAUX_JEV = new URL("./fixtures/faux-jev-web.mjs", import.meta.url).pathname;
const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;

/** A claim's tool environment: Parallel's key and a plane resolving both web tools to Parallel, under --faux. */
const claimEnv = (more = {}) => ({
  AGENTRUN_SERVE_FAUX: "1",
  AGENTRUN_SERVE_FAUX_PARALLEL: FAUX_PARALLEL,
  AGENTRUN_SERVE_FAUX_JEV: FAUX_JEV,
  AGENTRUN_SERVE_FAUX_WEB: FAUX_WEB,
  PARALLEL_API_KEY: PARALLEL_KEY,
  [TOOL_PLANE_ENV]: JSON.stringify({ web_search: "parallel", web_fetch: "parallel" }),
  ...more,
});

/** The web_receipt lines the server writes to stderr while `fn` runs, and what `fn` gave. */
async function receipts(t, fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  t.after(() => (process.stderr.write = write));
  try {
    const ledger = await toolLedger();
    const got = await bookedIn({ call: "test-call", paid: ledger }, fn);
    return { got, lines: lines.join("").split("\n").filter((line) => line.includes("event=web_receipt")) };
  } finally {
    process.stderr.write = write;
  }
}

/** A log line's fields, by name. */
const fieldsOf = (line) => Object.fromEntries([...line.matchAll(/(\w+)=("[^"]*"|\S+)/g)].map(([, key, value]) => [key, value.replace(/^"|"$/g, "")]));

/** What no receipt line may hold: a URL, a key, the page's words, the objective. */
function clean(line, ...more) {
  for (const forbidden of ["http://", "https://", "public.example", PARALLEL_KEY, JEV_KEY, "Read by Parallel", "The page at", ...more]) {
    assert.ok(!line.includes(forbidden), `the receipt line holds ${JSON.stringify(forbidden)}: ${line}`);
  }
}

test("a search ranked by Jev writes one web_receipt line: op, provider, its tries, the classifier's run, counts and model, and its cost", async (t) => {
  const objective = "Which state is Widgets, Inc. incorporated in?";
  const { got, lines } = await receipts(t, () => searchFor(claimEnv({ TYPESAFE_API_KEY: JEV_KEY }), { objective, n: 4 }));
  assert.equal(got.error, undefined, JSON.stringify(got).slice(0, 300));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^agentrun-serve: at=\S+ event=web_receipt /);
  const fields = fieldsOf(lines[0]);
  assert.equal(fields.op, "search");
  assert.equal(fields.provider, "parallel");
  assert.equal(fields.tries, "parallel:ok");
  assert.equal(fields.classifier, "ran");
  assert.equal(fields.classifier_in, "4");
  assert.equal(fields.classifier_kept, "4");
  assert.equal(fields.classifier_model, "jev-1.14.0");
  assert.ok(Number(fields.cost_usd) > 0, `a paid search and Jev's requests cost something: ${lines[0]}`);
  clean(lines[0], objective, "Widgets");
});

test("a fetch writes one web_receipt line, the classifier off with no TypeSafe key, ran on an objective with one; never the URL, its credentials or the page's text", async (t) => {
  const plain = await receipts(t, async () => (await webFetchTool(claimEnv()).execute({ url: "http://public.example/notes.txt" }, {}, {})).details);
  assert.equal(plain.got.ok, true, JSON.stringify(plain.got).slice(0, 300));
  assert.equal(plain.lines.length, 1, plain.lines.join("\n"));
  const read = fieldsOf(plain.lines[0]);
  assert.deepEqual([read.op, read.provider, read.tries, read.classifier], ["fetch", "parallel", "parallel:ok", "off"]);
  assert.ok(Number(read.cost_usd) > 0, plain.lines[0]);
  clean(plain.lines[0]);

  const objective = "where widgets are incorporated";
  const judged = await receipts(t, async () => (await webFetchTool(claimEnv({ TYPESAFE_API_KEY: JEV_KEY })).execute({ url: "http://public.example/notes.txt", objective }, {}, {})).details);
  assert.equal(judged.lines.length, 1, judged.lines.join("\n"));
  const found = fieldsOf(judged.lines[0]);
  assert.deepEqual([found.op, found.classifier, found.classifier_model], ["fetch", "ran", "jev-1.14.0"], judged.lines[0]);
  assert.match(found.classifier_kept ?? "", /^\d+$/, judged.lines[0]);
  clean(judged.lines[0], objective);

  const secret = "hunter2-secret";
  const credentialed = await receipts(t, async () => (await webFetchTool(claimEnv()).execute({ url: Object.assign(new URL("http://public.example/notes.txt"), { username: "reader", password: secret }).href }, {}, {})).details);
  assert.equal(credentialed.lines.length, 1, credentialed.lines.join("\n"));
  assert.equal(fieldsOf(credentialed.lines[0]).op, "fetch");
  clean(credentialed.lines[0], secret, "reader:");
});
