// Keyless Exa's search (Exa's public MCP endpoint, no key): its failures said in our words, never Exa's fix for an MCP
// URL; its free limit in web's words or the caller's (words.rateLimited); and its transport pinned to IPv4. Exa is the
// tests' fake (fixtures/faux-exa.mjs), and the IPv4 pin dials a loopback server: no socket leaves this machine. The
// cases that read serve's own words for the free limit stay in serve's web-search test.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as keyless from "../dist/index.js";
import fakeExa, { EXA_LIMIT_TEXT, resetFauxExa } from "./fixtures/faux-exa.mjs";
import { withEnv } from "./support.mjs";

const { exaSearch, RATE_LIMITED } = keyless;

test("keyless Exa's free limit is said in web's own words unless the caller gives its own (words.rateLimited), never Exa's", async (t) => {
  withEnv(t, { AGENTRUN_TEST_FAUX_EXA: "429" });
  const pause = async () => assert.fail("a wait past 5 s is not waited out");
  resetFauxExa();
  assert.deepEqual(await exaSearch("widgets", 3, { send: fakeExa, pause }), { error: RATE_LIMITED, limit: "rate_limited", retryAfterS: 30 });
  assert.equal(RATE_LIMITED, "Free web search is rate-limited right now. Try again in a minute.");
  resetFauxExa();
  assert.deepEqual(await exaSearch("widgets", 3, { send: fakeExa, pause, words: { rateLimited: "the caller's words" } }), { error: "the caller's words", limit: "rate_limited", retryAfterS: 30 });
});

test("any other failure Exa answers is said in our words, quoting only the first sentence of Exa's, at most 120 characters: never its fix for an MCP URL, even from a deployment that does not mark its limit", async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_EXA"]);
  /** Exa answering the search with `answer` (a tools/call body, as JSON), counting the searches it was sent. */
  const answering = (answer) => {
    const sent = [];
    const send = async (url, init) => {
      const { method, id } = JSON.parse(init.body);
      if (method !== "tools/call") return fakeExa(url, init);
      sent.push(method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { sent, send };
  };
  const SETUP = /Fix:|MCP URL|exaApiKey|exa\.ai|api-keys|Create a free Exa account/;
  // Exa's notice of its free limit with no ai.exa/rateLimited mark (an older deployment): a failure like any other,
  // not retried, and none of its setup text.
  const unmarked = answering({ result: { isError: true, content: [{ type: "text", text: EXA_LIMIT_TEXT }] } });
  const said = await exaSearch("widgets", 3, { send: unmarked.send, pause: async () => assert.fail("an unmarked failure is not retried") });
  assert.deepEqual(said, { error: 'Free web search failed. Exa said: "You\'ve hit Exa\'s free MCP rate limit."' });
  assert.doesNotMatch(said.error, SETUP);
  assert.equal(unmarked.sent.length, 1);
  // A JSON-RPC error, its message on several lines: the first sentence of the first line.
  const rpc = answering({ error: { code: -32000, message: `web_search_exa error (500): Internal error. Retry later.\nTimestamp: 2026-11-03T17:00:00Z\n\n${EXA_LIMIT_TEXT}` } });
  assert.deepEqual(await exaSearch("widgets", 3, { send: rpc.send }), { error: 'Free web search failed. Exa said: "web_search_exa error (500): Internal error."' });
  // A long first sentence is cut on a word, at most 120 characters.
  const long = answering({ result: { isError: true, content: [{ type: "text", text: `${"word ".repeat(60)}end` }] } });
  const cut = /^Free web search failed\. Exa said: "(.*)"$/.exec((await exaSearch("widgets", 3, { send: long.send })).error)?.[1];
  assert.ok(cut && cut.length <= 120 && cut.endsWith("…") && /^(word )+word…$/.test(cut), `cut on a word: ${cut}`);
  // A failure with no words: said so.
  const empty = answering({ result: { isError: true, content: [] } });
  assert.deepEqual(await exaSearch("widgets", 3, { send: empty.send }), { error: "Free web search failed: Exa gave no answer" });
});

test("keyless Exa is dialled over IPv4 alone: its name is looked up for family 4 and the connection goes to that address, on a host whose resolver answers IPv6 otherwise", async (t) => {
  assert.equal(typeof keyless.ipv4Fetch, "function", "exa-keyless has a transport pinned to IPv4");
  const server = createServer((request, response) => response.end(`over IPv4, to ${request.headers.host}`));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  // A host whose default route is IPv6: its resolver answers ::1 alone unless it is asked for family 4.
  const asked = [];
  const lookup = (host, options, callback) => {
    asked.push({ host, family: options?.family });
    const [address, family] = options?.family === 4 ? ["127.0.0.1", 4] : ["::1", 6];
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const transport = keyless.ipv4Fetch(lookup);
  t.after(() => transport.close());
  const answer = await transport.send(`http://exa.example:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(await answer.text(), `over IPv4, to exa.example:${port}`);
  assert.ok(asked.length > 0 && asked.every((call) => call.host === "exa.example" && call.family === 4), `every lookup asked for IPv4: ${JSON.stringify(asked)}`);
});
