// Jev's TypeSafe route sends TYPESAFE_API_KEY to TYPESAFE_BASE_URL, which TypeSafe's SDK reads from the environment
// itself when it is given no base. A saved key's check (key-check.ts) takes that variable by the rule of a URL a key
// goes to (httpsBase), and so does a run's decision provider: an http one is refused by name, and nothing is sent.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { decisionProvidersIn } from "../dist/decisions.js";

test("an http TYPESAFE_BASE_URL is refused by its name when a run's decision providers are built, and TYPESAFE_API_KEY goes nowhere", async (t) => {
  const heard = [];
  const server = createServer((req, res) => {
    // The provider's requests alone, by the key they carry: a probe of a new loopback listener from this machine is none.
    if (req.headers.authorization !== undefined) heard.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // The server's own environment, which the SDK reads as the run's provider does.
  const vars = { TYPESAFE_API_KEY: "fake-test-key", TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  Object.assign(process.env, vars);

  const built = await decisionProvidersIn(process.env).catch((error) => error);
  if (!(built instanceof Error)) {
    // Built anyway: one question, so where the key goes shows below.
    const questions = { holds: { type: "noul", instructions: "Does it hold?" } };
    await built.providers.jev.decide({ label: "x", kind: "judge", state: {}, questions }, { decisionId: "d", signal: AbortSignal.timeout(10_000), deadlineMs: 10_000 }).catch(() => undefined);
  }
  assert.deepEqual(heard, [], "TYPESAFE_API_KEY went to an http TYPESAFE_BASE_URL");
  assert.ok(built instanceof Error, "the providers were built on an http TYPESAFE_BASE_URL");
  assert.equal(built.message, "TYPESAFE_BASE_URL must be https, so the key never crosses in the clear: http:");
});

test("an https TYPESAFE_BASE_URL with a user, a password or a query is refused in words that give its origin alone", async (t) => {
  const saved = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL };
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value); });
  process.env.TYPESAFE_API_KEY = "fake-test-key";
  for (const [url, words] of [
    ["https://agent:" + "not-a-secret" + "@gateway.example", "TYPESAFE_BASE_URL takes no user or password, since the key goes to it: https://gateway.example"],
    ["https://gateway.example/?key=not-a-secret", "TYPESAFE_BASE_URL takes no query or fragment: https://gateway.example"],
  ]) {
    process.env.TYPESAFE_BASE_URL = url;
    await assert.rejects(decisionProvidersIn(process.env), (error) => error.message === words, words);
  }
});
