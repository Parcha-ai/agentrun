// The web extension's integration rig: a real pi-durable Harness on SQLite with pi-ai's faux model, the extension
// under test, and a local HTTP server standing in for the provider's Fetch and Search APIs. Helpers, not tests.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** A fake Fetch/Search API. `sites` maps a URL path to `{ status?, api?, body?, delayMs?, contentType? }`: `api` is the
 *  HTTP status the provider API itself answers; `status` is the page's. Records every call and peak concurrency. */
export async function startFake(sites) {
  const ledger = { fetch: [], search: [], inFlight: 0, peak: 0, dropped: 0 };
  const counts = {};
  const handle = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.on("close", () => { if (!res.writableEnded) ledger.dropped += 1; });
    ledger.inFlight += 1; ledger.peak = Math.max(ledger.peak, ledger.inFlight);
    try {
      if (req.url === "/search") {
        ledger.search.push(body);
        if (body.query === "limited") { res.statusCode = 429; res.end("{}"); return; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ results: Array.from({ length: Math.min(body.n, 3) }, (_, i) => ({ url: `https://found.example/${i}${body.query === "tokens" ? "?apikey=SEARCHSENTINEL99" : ""}`, title: `Hit ${i}`, ...(i === 0 ? { author: "A. Writer", published: "2026-09-01" } : {}), snippet: "dropped" })) }));
        return;
      }
      ledger.fetch.push(body);
      const entry = sites[new URL(body.url).pathname] ?? { body: "# Example\n\nBody" };
      const seen = (counts[new URL(body.url).pathname] = (counts[new URL(body.url).pathname] ?? -1) + 1);
      const picked = Array.isArray(entry) ? entry[Math.min(seen, entry.length - 1)] : entry;
      // `byFormat` answers a markdown request and a raw one differently (a provider that converts one but not the other).
      const site = picked.byFormat ? { ...picked, ...(picked.byFormat[body.format] ?? {}) } : picked;
      if (site.hold) await new Promise(() => {});
      if (site.delayMs) await new Promise((r) => setTimeout(r, site.delayMs));
      res.statusCode = site.api ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ finalUrl: site.finalUrl ?? body.url, statusCode: site.status ?? 200, contentType: site.contentType ?? "text/markdown", content: site.body ?? "# Example\n\nBody" }));
    } finally { ledger.inFlight -= 1; }
  };
  const server = http.createServer((req, res) => {
    // The server listens on an ephemeral port, and other programs on a busy box probe ports (a Go HTTP client has been seen
    // sending GET / to it). Anything but the two API routes is answered 404 and never recorded, so a stray request cannot
    // reach the ledger the tests count, or throw an error the test runner would pin on whichever test is running.
    if (req.method !== "POST" || (req.url !== "/fetch" && req.url !== "/search")) { req.resume(); res.statusCode = 404; res.end(); return; }
    handle(req, res).catch(() => { if (!res.headersSent) res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, payload, signal) => {
    const res = await fetch(base + route, { method: "POST", body: JSON.stringify(payload), signal });
    if (!res.ok) throw Object.assign(new Error(`${route} answered ${res.status}`), { status: res.status });
    return res.json();
  };
  return { ledger, base, fetch: (request, signal) => call("/fetch", request, signal), search: (request, signal) => call("/search", request, signal), close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

/** Files each record as `<dir>/<label>/<n>-<tool>.md` the way a host sink would, and keeps what it was given. */
export function fileSink(dir, extra = {}) {
  const filed = [];
  return {
    filed,
    sink: {
      async file(label, record) {
        const folder = path.join(dir, label); fs.mkdirSync(folder, { recursive: true });
        const header = [`tool: ${record.tool}`, `args: ${JSON.stringify(record.args)}`, `status: ${record.status}`, ...Object.entries(record.facts).map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
        const file = path.join(folder, `${String(filed.length + 1).padStart(3, "0")}-${record.tool}.md`);
        fs.writeFileSync(file, header + record.body);
        filed.push({ label, record, file });
        return { path: path.relative(dir, file), bodyLine: header.split("\n").length };
      },
      ...extra,
    },
  };
}

const textOf = (message) => (message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");

/** Open a harness whose model makes `rounds` of tool calls (each an array of [tool, args]) and then answers. The
 *  policy reads the transcript, never a counter, so a process that resumes the same file continues where it was cut. */
export async function open(extension, rounds, db = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "web-")), "run.sqlite")) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const policy = (context) => {
    const round = rounds[context.messages.filter((m) => m.role === "assistant").length];
    return round ? fauxAssistantMessage(round.map(([tool, args]) => fauxToolCall(tool, args)), { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  };
  faux.setResponses(Array.from({ length: rounds.length + 4 }, () => policy));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  return { harness, root, db };
}

/** What the conversation's tool results say, in order. */
export async function transcript(root) {
  const page = await root.entries({}, 200, undefined, ctx);
  const entries = [...page.items].reverse();
  // A round's calls run at once and their results land as each finishes; they are listed in the order the model made them.
  const order = new Map();
  for (const e of entries) for (const block of e.kind === "pi.assistant" ? e.model?.[0]?.content ?? [] : []) if (block.type === "toolCall") order.set(block.id, order.size);
  return entries.flatMap((e) => {
    const m = e.model?.[0];
    return e.kind === "pi.tool-result" ? [{ order: order.get(m.toolCallId) ?? Infinity, tool: m.toolName, isError: m.isError, text: textOf(m), details: m.details ?? null, usage: m.usage ?? null }] : [];
  }).sort((a, b) => a.order - b.order).map(({ order: _order, ...result }) => result);
}

/** Run one conversation to its answer. Resolves with every tool result, the session's usage and the settled status. */
export async function drive(extension, rounds, db) {
  const { harness, root } = await open(extension, rounds, db);
  try {
    const settled = await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
    return { results: await transcript(root), usage: await harness.usage(ctx), settled };
  } finally { await harness.close(ctx); }
}
