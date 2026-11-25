// A fake of a keyed provider's HTTP API (Exa's, Firecrawl's) on 127.0.0.1, for the keyed providers' tests. Only a POST
// under its own base, /<a random nonce>, is the fake's: each is kept in `got` (its path below the base, its headers and
// its JSON body) and answered as `answer(path, body, n)` says (n counted over every request): `{status, headers, json}`,
// status 200 by default. Any other request is answered 404, never kept. `calls(path)` counts the requests to one path.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** The keys the keyed tests hold: canaries, so a test can say a key never reaches an answer, a receipt or a log. */
export const EXA_CANARY = "exa-key-canary-7d1f";
export const FIRECRAWL_CANARY = "fc-key-canary-91ab";

/** A JSON answer: `json` with `status` (200) and `headers`. */
export const ok = (json, headers = {}) => ({ status: 200, headers, json });
export const refused = (status, json = { error: "refused" }, headers = {}) => ({ status, headers, json });

export async function keyedServer(t, answer) {
  const base = `/${randomUUID()}`;
  const got = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith(`${base}/`)) return void res.writeHead(404).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = req.url.slice(base.length);
    got.push({ path, headers: req.headers, body });
    const said = (await answer(path, body, got.length)) ?? { status: 404, json: { error: "no answer" } };
    res.writeHead(said.status ?? 200, { "content-type": "application/json", ...said.headers }).end(JSON.stringify(said.json ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}${base}`, got, calls: (path) => got.filter((one) => one.path === path).length };
}

/** Exa's search answer: each hit `{url, title, highlights?, text?, publishedDate?}`, and Exa's own cost estimate. */
export const exaResults = (rows, total = 0.017) => ok({ requestId: "req-exa-1", results: rows, costDollars: { total }, searchTime: 120 });
export const EXA_HITS = [
  { id: "https://first.example/widgets", url: "https://first.example/widgets", title: "Widgets, explained", publishedDate: "2026-11-01T00:00:00.000Z", highlights: ["Widgets are [small](https://first.example/s) parts.", "They   fit together."] },
  { id: "https://second.example/gadgets", url: "https://second.example/gadgets", title: "Gadgets", highlights: ["A second result."] },
  { id: "not a url", url: "not a url", title: "Broken", highlights: ["No URL this server reads."] },
];
/** Exa's contents answer for one URL read. */
export const exaPage = (url, text, title = "Read by Exa") => ok({ requestId: "req-exa-2", results: [{ id: url, url, title, text }], statuses: [{ id: url, status: "success", source: "cached" }], costDollars: { total: 0.001 } });
/** Exa's contents answer for one URL it could not read. */
export const exaUnread = (url, tag = "CRAWL_NOT_FOUND", httpStatusCode = 404) => ok({ requestId: "req-exa-3", results: [], statuses: [{ id: url, status: "error", error: { tag, httpStatusCode } }], costDollars: { total: 0 } });

/** Firecrawl's search answer (v2): `data.web` rows `{url, title, description}`. */
export const firecrawlResults = (rows, creditsUsed = 2) => ok({ success: true, data: { web: rows }, creditsUsed, id: "search-fc-1" });
export const FIRECRAWL_HITS = [
  { url: "https://first.example/widgets", title: "Widgets, explained", description: "All about [widgets](https://first.example/more) and   their uses." },
  { url: "https://second.example/gadgets", title: "Gadgets", description: "A second result." },
  { url: "not a url", title: "Broken", description: "No URL this server reads." },
];
/** Firecrawl's scrape answer (v2) for a page with `statusCode`. */
export const firecrawlPage = (url, markdown, statusCode = 200, title = "Read by Firecrawl") => ok({ success: true, data: { markdown, metadata: { title, sourceURL: url, url, statusCode } } });
