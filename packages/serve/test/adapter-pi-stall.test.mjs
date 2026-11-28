// A pi run whose provider takes the request and then sends nothing ends failed, in words that name the stall, after one
// request: the session's model proxy stops the request at its stall bound (here a short one) and answers pi in words its
// retry does not ask again on. Before, the request waited on the transport (Node's fetch cut it after 5 minutes as
// "terminated: Body Timeout Error"), pi retried that up to 8 times, and the run stayed working the whole while with one
// "Model request failed: terminated" row a request. Here the provider never times out at all: without the bound, the run
// never ends. Its claim is let go once it ends, and the request is booked once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, rootEntries } from "./adapter-pi-cap-support.mjs";
import { timelineOf } from "../dist/timeline/index.js";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
after(closeOpenSessions);

/** The session proxy's stall bound for these runs. Real time: the run's runner and pi run on it. */
const STALL_MS = 1_000;
/** How long a run is given to end before the case reads it as still running: well past one bound, far short of a retry's. */
const ENDS_WITHIN_MS = 60_000;
/** The proxy's words for a request it stopped at the bound (the kernel's stalledWords). */
const WORDS = "the model sent nothing for 1 s, so the request was stopped";

const sse = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
/** A provider that takes each request and then sends nothing, ever: `headers` true, its 200 and its first event first;
 *  false, not even its headers. It gives up only when the proxy stops the request. */
const silent = (headers, sent) => async (_url, init = {}) => {
  sent.push(JSON.parse(String(init.body ?? "{}")));
  const stopped = new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  stopped.catch(() => undefined);
  if (!headers) return stopped;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } })));
      stopped.catch((reason) => controller.error(reason));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

for (const [how, headers] of [["after its headers and first event", true], ["before its headers", false]]) {
  test(`a provider silent ${how}: the run fails after one request, in the stall's words, and lets its claim go`, async (t) => {
    const sent = [];
    const { row, store } = await capRun(t, {
      specOf: () => (_claim, run) => ({
        adapter: piAdapter({ redact: heldRedactor((text) => text), run, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => "not-a-secret" }, fetch: silent(headers, sent), price: () => 0, stallMs: STALL_MS }),
        session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh" },
        input: "Say hi.",
        hooks: quiet,
        gate: () => "allow",
      }),
      runCap: { capUsd: () => undefined, modelOf: () => undefined },
      ms: ENDS_WITHIN_MS,
    });
    assert.equal(row.state, "failed", `the run ended failed: ${JSON.stringify(row)}`);
    assert.equal(row.runner, null, "its claim was let go");
    assert.equal(sent.length, 1, "one request: the stall is not asked again");
    assert.ok(String(row.summary ?? "").includes(WORDS), `the run's error names the stall: ${row.summary}`);
    const rows = timelineOf(await rootEntries(store), { settled: true });
    const failed = rows.filter((r) => r.kind === "error" && String(r.summary ?? "").startsWith("Model request failed"));
    assert.deepEqual(failed.map((r) => r.summary.replace(/ \(its cost is unknown.*$/, "")), [`Model request failed: ${WORDS}`], JSON.stringify(rows.map((r) => [r.kind, r.summary])));
    assert.equal(rows.find((r) => r.kind === "usage")?.usage?.requests, 1, "the request is booked once");
  });
}
