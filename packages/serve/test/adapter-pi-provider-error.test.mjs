// A provider's error text never carries a secret into what the run keeps: on either wire, an upstream that answers an
// error echoing the provider's credential (as a provider does with a wrong key: "Incorrect API key provided: <key>")
// leaves no trace of the credential in the run's record (everything its store keeps on disk) or its summary.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { capRun, quiet } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { WIRES } = await import("../dist/wires.js");
after(closeOpenSessions);

/** A credential-shaped value, planted: the provider's key as the route holds it. */
const PLANTED = `sk-planted-${"q".repeat(8)}-a1b2c3d4e5f6a7b8c9d0`;

const sse = (events) => events.map((event) => `${event.name ? `event: ${event.name}\n` : ""}data: ${JSON.stringify(event.data)}\n\n`).join("");
/** An upstream that refuses every request with an error whose words echo the key it was given, as `wire`'s API says one:
 *  as an answer with an error status, and as an error event inside a streamed answer (each of the wire's). */
const ECHOING = {
  "anthropic-messages": {
    model: MODEL,
    answer: () => ({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${PLANTED}` } }),
    streams: [sse([{ name: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 3, output_tokens: 1 } } } }, { name: "error", data: { type: "error", error: { type: "authentication_error", message: `upstream refused key ${PLANTED}` } } }])],
  },
  "openai-responses": {
    model: "gpt-5",
    answer: () => ({ error: { message: `Incorrect API key provided: ${PLANTED}. You can find your API key at the provider.`, type: "invalid_request_error", code: "invalid_api_key" } }),
    streams: [
      sse([{ data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } }, { data: { type: "error", code: "invalid_api_key", message: `Incorrect API key provided: ${PLANTED}.` } }]),
      sse([{ data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } }, { data: { type: "response.failed", response: { id: "resp_1", status: "failed", error: { code: "invalid_api_key", message: `Incorrect API key provided: ${PLANTED}.` } } } }]),
    ],
  },
};

/** Every file under `dir`, its bytes as text. */
function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path).toString("latin1") });
  }
  return out;
}

test("a provider's error that echoes its credential leaves the credential nowhere in the run's record or summary, on either wire", async (t) => {
  assert.deepEqual(Object.keys(ECHOING).sort(), Object.keys(WIRES).sort(), "every wire");
  for (const [wire, { model, answer, streams }] of Object.entries(ECHOING)) {
    const cases = [
      ["an error status", 401, JSON.stringify(answer()), "application/json"],
      ...streams.map((stream, i) => [`an error event in a stream (${i + 1})`, 200, stream, "text/event-stream"]),
    ];
    for (const [how, status, said, type] of cases) await t.test(`${wire}: ${how}`, async (t) => {
      const sent = [];
      const upstream = async (_url, init = {}) => {
        sent.push(JSON.parse(String(init.body ?? "{}")));
        return new Response(said, { status, headers: { "content-type": type } });
      };
      const { row, dir, store } = await capRun(t, {
        specOf: () => (_claim, run) => ({
          adapter: piAdapter({ run, model, provider: { api: wire, origin: "https://faux.invalid", credential: () => PLANTED }, fetch: upstream, price: () => 0 }),
          session: { key: "root", label: "root", system: ["Answer."], tools: hostTools({}), context: "fresh" },
          input: "Answer.",
          hooks: quiet,
          gate: () => "allow",
        }),
        runCap: { capUsd: () => undefined, modelOf: () => undefined },
      });
      assert.ok(sent.length >= 1, "the provider was asked, and refused");
      assert.ok(!JSON.stringify(row).includes(PLANTED), `the run's row (its summary among it): ${JSON.stringify(row)}`);
      await store.flush?.();
      const leaked = filesUnder(dir).filter((file) => file.text.includes(PLANTED)).map((file) => file.path.slice(dir.length));
      assert.deepEqual(leaked, [], "no file of the run's store holds the credential");
    });
  }
});
