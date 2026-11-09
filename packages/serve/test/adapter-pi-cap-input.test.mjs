// pi through the adapter under a cap: what the cap is asked about a request is what the request carries. Its input is
// bounded by its body's UTF-8 bytes (the session proxy measures them), never pi's own average of about 3.5 characters a
// token, so a dense text whose bytes pass the cap is not sent.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { beforeRequestOf, capRun, quiet, SONNET } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
after(closeOpenSessions);

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` };
/** A spec of pi on `fetch` with `input` as the person's first message. */
const specWith = (fetch, input) => (_claim, run) => ({
  adapter: piAdapter({ run, model: MODEL, provider, fetch, price: () => 0 }),
  session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh" },
  input,
  hooks: quiet,
  gate: () => "allow",
});

test("pi's input is bounded by its request's UTF-8 bytes, never pi's average: a dense text whose bytes pass the cap is not sent", async (t) => {
  // Four bytes a character: 2,000 of them are 8,000 bytes, about 570 tokens by pi's average.
  const dense = "\u{1F600}".repeat(2_000);
  const bytes = Buffer.byteLength(dense, "utf8");
  const average = Math.ceil(dense.length / 3.5);
  // $1 per million input tokens and nothing for output: a request's worst case is its input bound; the cap sits between.
  const inputOnly = { ...SONNET, price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const capUsd = (average + bytes) / 2 / 1e6;
  const { asked, sent } = await capRun(t, { specOf: (got) => specWith(async (url, init) => (got.push(init), sse([])), dense), runCap: ({ capUsd: () => capUsd, modelOf: () => inputOnly }) });
  assert.ok(asked[0]?.request.inputTokensMax >= bytes, `the bound is at least the input's bytes: ${asked[0]?.request.inputTokensMax} of ${bytes}`);
  assert.match(asked[0]?.answer?.refuse ?? "", /^spend_cap_reached \(out of budget\): Not sent: /, JSON.stringify(asked[0]?.answer));
  assert.equal(sent.length, 0, "not sent: its byte bound passes the cap");
});
