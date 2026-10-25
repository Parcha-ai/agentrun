// fetch_page: one public web page as a Page, on pi-browser's public-host guard. The network here is a table (no socket):
// every hostile target must be refused before it is dialled, in the tool itself, in an agentic run's process and in a
// workflow's call node, and the public page must answer.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fetchPage } from "../dist/fetch-page.js";
import { network } from "./fixtures/fake-network.mjs";
import { answerFlow, client, follow, scratch, serve } from "./support.mjs";

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
  const { text, ...rest } = page;
  assert.deepEqual(rest, PUBLIC, "the title, and each http(s) link once, absolute, without its fragment; no mailto");
  assert.match(text, /The answer is forty-two\./);
  assert.deepEqual(net.dialled, ["http://public.example/"]);
  assert.deepEqual(await fetchPage("http://public.example/notes.txt", network()), { ok: true, url: "http://public.example/notes.txt", status: 200, title: "", text: "Plain notes.", links: [] });
  assert.match((await fetchPage("http://public.example/image.png", network())).refused, /image\/png is not text/);
  assert.equal((await fetchPage("http://public.example:8080/", network())).refused, "refused: port 8080 is not 80 or 443", "a public host on another port");
  for (const url of ["http://public.example:80/", "http://public.example:443/", "https://public.example:443/"]) assert.notEqual((await fetchPage(url, network())).refused?.startsWith("refused: port"), true, url);
  assert.deepEqual(await fetchPage("http://public.example/missing", network()), { ok: false, url: "http://public.example/missing", status: 404, title: "", text: "", links: [], error: "the page answered 404" });
  assert.deepEqual(await fetchPage("not a url", network()), { ok: false, url: "not a url", status: 0, title: "", text: "", links: [], error: "url is not an absolute URL" });
  assert.match((await fetchPage("http://nowhere.example/", network())).error, /ENOTFOUND/);
});

/** What each fetch_page call of run `runId` was answered, parsed, from its released store. */
function pagesOf(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult" && message.toolName === "fetch_page")
      .map((message) => JSON.parse((message.content ?? []).map((c) => c.text ?? "").join("")));
  } finally {
    db.close();
  }
}

test("an agentic run's fetch_page in its own process: every hostile target refused (ok false, never dialled), the public page answered", async (t) => {
  const log = join(await scratch(t), "dialled.txt");
  const saved = process.env.FAUX_WEB_LOG;
  process.env.FAUX_WEB_LOG = log;
  t.after(() => (saved === undefined ? delete process.env.FAUX_WEB_LOG : (process.env.FAUX_WEB_LOG = saved)));
  const { api, baseUrl, data } = await serve(t, { fauxWeb: FAUX_WEB });
  const listed = (await client(baseUrl)("GET", "/capabilities")).body.tools.find((tool) => tool.name === "fetch_page");
  assert.deepEqual([listed.available, listed.nodes, listed.calls, listed.missing], [true, true, true, undefined], "no key needed");
  assert.equal((await api("POST", "/agents", { definition: { id: "reader", name: "reader", instructions: "Read.", tools: ["fetch_page"] } })).status, 201);
  const urls = [...HOSTILE.map(([url]) => url), "http://public.example/"];
  const started = await api("POST", "/agents/reader/runs", { input: { content: `Fetch these pages: ${JSON.stringify(urls)}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  const pages = pagesOf(data, started.body.run_id);
  assert.equal(pages.length, urls.length);
  HOSTILE.forEach(([url], i) => assert.match(pages[i].refused ?? "", /^refused: /, `${url}: ${JSON.stringify(pages[i])}`));
  assert.deepEqual((({ text, ...rest }) => rest)(pages.at(-1)), PUBLIC);
  const dialled = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(dialled, ["http://redirect.example/", "http://renamed.example/", "http://public.example/"], "only public addresses were dialled");
});

test("a workflow's call node runs fetch_page: the Page is its output, a refusal is ok false and the workflow goes on; a call to a tool outside the table is 409", async (t) => {
  const { api } = await serve(t, { fauxWeb: FAUX_WEB });
  const flow = {
    v: 2, name: "read-site",
    schemas: {
      In: { type: "object", required: ["website"], properties: { website: { type: "string" } } },
      Page: { type: "object", required: ["ok", "url", "status", "title", "text", "links"], properties: { ok: { type: "boolean" }, url: { type: "string" }, status: { type: "integer" }, title: { type: "string" }, text: { type: "string" }, links: { type: "array", items: { type: "string" } }, refused: { type: "string" }, error: { type: "string" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Page", path: "home" },
    root: { node: "chain", steps: [{ node: "call", label: "Read the home page", via: "tool", tool: "fetch_page", args: { url: "{website}" }, out: "Page", as: "home", deadline_s: 60 }] },
  };
  assert.equal((await api("POST", "/agents", { definition: { id: "site", name: "site", workflow: flow, tools: ["fetch_page"] } })).status, 201);
  const run = async (website) => {
    const started = await api("POST", "/agents/site/runs", { input: { website } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"]);
    return (await api("GET", `/runs/${started.body.run_id}`)).body.result.output;
  };
  assert.deepEqual((({ text, ...rest }) => rest)(await run("http://public.example/")), PUBLIC);
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
  assert.equal((await api("POST", "/agents", { definition: { id: "fed", name: "fed", workflow: fed, tools: ["fetch_page"] } })).status, 201);
  const fedRun = await api("POST", "/agents/fed/runs", { input: { website: "http://public.example/" } });
  assert.equal(fedRun.status, 202, JSON.stringify(fedRun.body));
  await follow(api, fedRun.body.run_id, ["completed"]);
  assert.deepEqual((await api("GET", `/runs/${fedRun.body.run_id}`)).body.result.output, { answer: 42 });
  // A call to a tool outside the table, or to one no call node may run, is refused before anything starts.
  for (const tool of ["http_get", "read"]) {
    const other = structuredClone(flow);
    other.root.steps[0].tool = tool;
    assert.equal((await api("POST", "/agents", { definition: { id: `call-${tool}`, name: tool, workflow: other, tools: [tool] } })).status, 201);
    const refused = await api("POST", `/agents/call-${tool}/runs`, { input: { website: "http://public.example/" } });
    assert.deepEqual([refused.status, refused.body.error.details.unbound], [409, [tool]], tool);
    assert.match(refused.body.error.message, /call nodes run the tools fetch_page/);
  }
});
