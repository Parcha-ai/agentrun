// An MCP server's URL is kept and shown in plain text (its row's url, every read, the console), so a credential in its
// query would be too: a URL whose query names a parameter that looks like a credential (api_key, token, secret,
// signature, ...) is refused at every door that takes one (the preview, the save, the OAuth sign-in's start), in words
// that say to send it as a header, and nothing is kept or sent. A query of anything else (?version=2) is the server's own.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { serve, withEnv } from "./support.mjs";

const SECRET = `not-a-secret-${"query-credential"}`;

test("a URL whose query holds a credential-like parameter is refused at the preview, the save and the sign-in's start, in words, and nothing is kept or sent; ?version=2 still saves", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { runner: false });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  for (const name of ["api_key", "API-Key", "apikey", "access_token", "token", "key", "secret", "client_secret", "auth", "password", "sig", "signature", "X-Api-Key"]) {
    const url = `${fake.url}?region=eu&${encodeURIComponent(name)}=${SECRET}`;
    const words = `${name} in the URL's query looks like a credential; send it as a header instead (Headers).`;
    for (const [door, answer] of [
      ["preview", await api("POST", "/settings/mcp-servers/preview", { url, auth: { type: "none" } })],
      ["save", await api("PUT", "/settings/mcp-servers/queried", { url, auth: { type: "none" } })],
      ["sign-in start", await api("POST", "/settings/mcp-servers/queried/oauth/start", { url })],
    ]) {
      assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], `${name} at the ${door}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(answer.body.error.fields.map((field) => [field.field, field.message]), [["url", words]], `${name} at the ${door}`);
      assert.ok(!JSON.stringify(answer.body).includes(SECRET), `${name} at the ${door}: the value is not said back`);
    }
  }
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body, { servers: [] }, "nothing kept");
  assert.equal(fake.log.length, 0, "nothing sent to the server");
  // A query of the server's own, nothing like a credential, is kept as given.
  const plain = await api("PUT", "/settings/mcp-servers/versioned", { url: `${fake.url}?version=2`, auth: { type: "none" } });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.url, `${fake.url}?version=2`);
});
