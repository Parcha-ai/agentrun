// The guarded direct fetch, web_fetch's: one public web page as a Page, on pi-browser's
// public-host guard. The network here is a table (no socket): every hostile target must be refused before it is dialled,
// in the fetch itself and in a workflow's call node (an agentic run's, on the runner: web-fetch-ssrf-runner.test.mjs), and the public page must answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPage } from "../dist/web-fetch-direct.js";
import { network } from "./fixtures/fake-network.mjs";
import { answerFlow, follow, serve } from "./support.mjs";

const FAUX_WEB = new URL("./fixtures/faux-web.mjs", import.meta.url).pathname;

/** Every target that must be refused, and whether a first hop is dialled before the refusal (a redirect's). */
const HOSTILE = [
  ["http://127.0.0.1:9421/v1/models", false],
  ["http://127.0.0.1/", false],
  ["http://localhost:8080/", false],
  ["http://localhost/", false],
  ["http://public.example:8080/", false],
  ["http://app.localhost/", false],
  ["http://169.254.169.254/latest/meta-data/", false],
  ["http://10.0.0.1/", false],
  ["http://172.16.0.1/", false],
  ["http://192.168.1.1/", false],
  ["http://100.64.0.1/", false],
  ["http://[::1]/", false],
  ["http://[fc00::1]/", false],
  ["http://[::ffff:127.0.0.1]/", false],
  ["http://evil.example/", false],
  ["http://mixed.example/", false],
  ["http://redirect.example/", true],
  ["http://renamed.example/", true],
  ["file:///etc/passwd", false],
  ["data:text/html,<h1>hi</h1>", false],
  ["ftp://public.example/", false],
];

const PUBLIC = {
  ok: true, url: "http://public.example/", status: 200, title: "Public page",
  links: ["http://public.example/about", "https://other.example/x"],
};
/** A page less its text and `chars`, which is checked to be the text's length. */
const textless = ({ text, chars, ...rest }) => (assert.equal(chars, text.length, "chars, the length of the text"), rest);

test("the tool refuses every private, local and non-http(s) target before it is dialled, a redirect's next hop too; a public page answers", async () => {
  for (const [url, firstHop] of HOSTILE) {
    const net = network();
    const page = await fetchPage(url, net);
    assert.equal(page.ok, false, url);
    assert.match(page.refused ?? "", /^refused: /, `${url}: ${JSON.stringify(page)}`);
    assert.equal(page.error, undefined, url);
    assert.deepEqual(net.dialled, firstHop ? [url] : [], `${url} dials nothing private`);
  }
  const net = network();
  const page = await fetchPage("http://public.example/", net);
  assert.deepEqual(textless(page), PUBLIC, "the title, and each http(s) link once, absolute, without its fragment; no mailto");
  assert.match(page.text, /The answer is forty-two\./);
  assert.deepEqual(net.dialled, ["http://public.example/"]);
  assert.deepEqual(await fetchPage("http://public.example/notes.txt", network()), { ok: true, url: "http://public.example/notes.txt", status: 200, title: "", text: "Plain notes.", chars: 12, links: [] });
  assert.match((await fetchPage("http://public.example/image.png", network())).refused, /image\/png is not text/);
  assert.equal((await fetchPage("http://public.example:8080/", network())).refused, "refused: port 8080 is not 80 or 443", "a public host on another port");
  for (const url of ["http://public.example:80/", "http://public.example:443/", "https://public.example:443/"]) assert.notEqual((await fetchPage(url, network())).refused?.startsWith("refused: port"), true, url);
  assert.deepEqual(await fetchPage("http://public.example/missing", network()), { ok: false, url: "http://public.example/missing", status: 404, title: "", text: "", links: [], error: "the page answered 404" });
  assert.deepEqual(await fetchPage("not a url", network()), { ok: false, url: "not a url", status: 0, title: "", text: "", links: [], error: "url is not an absolute URL" });
  assert.match((await fetchPage("http://nowhere.example/", network())).error, /ENOTFOUND/);
});

test("a URL on a port other than 80 or 443 is refused before its host is looked up or dialled", async () => {
  const net = network();
  const looked = [];
  const lookup = (host, ...rest) => (looked.push(host), net.lookup(host, ...rest));
  const page = await fetchPage("http://public.example:8080/", { ...net, lookup });
  assert.equal(page.refused, "refused: port 8080 is not 80 or 443");
  assert.deepEqual(looked, [], "no lookup for a port it refuses");
});

test("a workflow's call node runs web_fetch: the Page is its output, a refusal is ok false and the workflow goes on; a call to a tool outside the table is refused at save (422)", async (t) => {
  const { api } = await serve(t, { fauxWeb: FAUX_WEB });
  const flow = {
    v: 2, name: "read-site",
    schemas: {
      In: { type: "object", required: ["website"], properties: { website: { type: "string" } } },
      Page: { type: "object", required: ["ok", "url", "status", "title", "text", "links"], properties: { ok: { type: "boolean" }, url: { type: "string" }, status: { type: "integer" }, title: { type: "string" }, text: { type: "string" }, links: { type: "array", items: { type: "string" } }, refused: { type: "string" }, error: { type: "string" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Page", path: "home" },
    root: { node: "chain", steps: [{ node: "call", label: "Read the home page", via: "tool", tool: "web_fetch", args: { url: "{website}" }, out: "Page", as: "home", deadline_s: 60 }] },
  };
  assert.equal((await api("POST", "/agents", { definition: { id: "site", name: "site", workflow: flow, tools: ["web_fetch"] } })).status, 201);
  const run = async (website) => {
    const started = await api("POST", "/agents/site/runs", { input: { website } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"]);
    return (await api("GET", `/runs/${started.body.run_id}`)).body.result.output;
  };
  assert.deepEqual(textless(await run("http://public.example/")), { ...PUBLIC, via: "direct" });
  for (const website of ["http://169.254.169.254/latest/meta-data/", "http://redirect.example/", "file:///etc/passwd"]) {
    const page = await run(website);
    assert.deepEqual([page.ok, /^refused: /.test(page.refused)], [false, true], `${website}: ${JSON.stringify(page)}`);
  }
  // The showcase's shape: the page feeds a fast model node, which reads its title through state.
  const fed = answerFlow();
  fed.schemas.In = flow.schemas.In;
  fed.schemas.Page = flow.schemas.Page;
  fed.root.steps.unshift(flow.root.steps[0]);
  Object.assign(fed.root.steps[1], { node: "agent", state: { url: "{home.url}", title: "{home.title}", page: "{home.text}" }, tools: [], tier: "fast", budget_usd: 0.05 });
  assert.equal((await api("POST", "/agents", { definition: { id: "fed", name: "fed", workflow: fed, tools: ["web_fetch"] } })).status, 201);
  const fedRun = await api("POST", "/agents/fed/runs", { input: { website: "http://public.example/" } });
  assert.equal(fedRun.status, 202, JSON.stringify(fedRun.body));
  await follow(api, fedRun.body.run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${fedRun.body.run_id}`)).body.result.output, { answer: 42 });
  // A call to a tool outside the table, or to one no call node may run, is refused when the workflow is saved.
  for (const tool of ["http_get", "read"]) {
    const other = structuredClone(flow);
    other.root.steps[0].tool = tool;
    const refused = await api("POST", "/agents", { definition: { id: `call-${tool}`, name: tool, workflow: other, tools: [tool] } });
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => f.field)], [422, ["definition.workflow"]], tool);
    assert.match(refused.body.error.fields[0].message, new RegExp(`call nodes run the tools web_fetch, web_search, pdf_pages, llm here; this workflow also calls ${tool}\\.`));
  }
});

test("a host that answers with a bot-protection challenge is said to refuse an automated read, naming what reads such pages; a missing page is still the status it answered", async () => {
  const guarded = await fetchPage("http://guarded.example/", network());
  assert.equal(guarded.ok, false);
  assert.equal(guarded.status, 403);
  assert.match(guarded.error, /^the host refused an automated read \(it answered 403 with a bot-protection challenge\)\./);
  assert.match(guarded.error, /with a Parallel key set on this server, web_fetch reads through Parallel/);
  const missing = await fetchPage("http://public.example/gone", network());
  assert.equal(missing.error, "the page answered 404");
});
