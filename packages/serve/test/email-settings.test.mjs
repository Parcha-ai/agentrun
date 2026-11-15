// The server's email account through /v2/settings/email, from the owner's session only (secret-writes.ts): GET names the
// account (its address, its servers and who signs in), never its password; PUT saves it from a preset or servers of the
// person's own, Outlook refused in words; POST /test signs in to IMAP (INBOX opened read-only, its count said) and to
// SMTP, sending nothing, for the saved account or the one in its body; DELETE forgets it. The password is sealed (the store
// holds no clear copy of it) and is in no answer, event or log line.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { schemaProblems } from "./schema-support.mjs";
import { client, serve, storeBytes, withEnv } from "./support.mjs";
import { accountBody, ADDRESS, mailbox } from "./email-support.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };

/** The served document's schema check for `method` `path`'s `code` answer. */
async function meets(api, method, path, code, value) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths[path][method].responses[code].content["application/json"].schema, value), [], `${method} ${path} ${code}: ${JSON.stringify(value)}`);
}

test("GET, PUT, test and DELETE: the account's view never holds the password; presets fill the servers; Outlook is refused in words; the test signs in to both and sends nothing", { timeout: 120_000 }, async (t) => {
  withEnv(t, SEAL);
  const lines = [];
  const server = await serve(t, { runner: false, log: (line) => lines.push(line) });
  const { api, data } = server;
  const faux = await mailbox(t);
  faux.seed({ subject: "One" });
  faux.seed({ subject: "Two" });

  const empty = await api("GET", "/settings/email");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body, { configured: false, preset: null, address: null, user: null, imap: null, smtp: null, password_unreadable: false });
  await meets(api, "get", "/settings/email", "200", empty.body);

  const outlook = await api("PUT", "/settings/email", { ...accountBody(faux), preset: "outlook" });
  assert.equal(outlook.status, 422, JSON.stringify(outlook.body));
  assert.equal(outlook.body.error.fields[0].message, "Outlook needs Microsoft sign-in, which this server doesn't do yet.");
  const missing = await api("PUT", "/settings/email", { preset: "other", address: "not an address" });
  assert.equal(missing.status, 422);
  assert.deepEqual(missing.body.error.fields.map((f) => f.field).sort(), ["address", "imap", "password", "smtp"]);

  const gmail = await api("PUT", "/settings/email", { preset: "gmail", address: "me@gmail.com", password: faux.password });
  assert.equal(gmail.status, 200, JSON.stringify(gmail.body));
  assert.deepEqual(gmail.body, { configured: true, preset: "gmail", address: "me@gmail.com", user: "me@gmail.com", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, password_unreadable: false });
  for (const [preset, imap, smtp] of [["fastmail", "imap.fastmail.com:993", "smtp.fastmail.com:465"], ["icloud", "imap.mail.me.com:993", "smtp.mail.me.com:587"]]) {
    const view = (await api("PUT", "/settings/email", { preset, address: "me@example.com", password: faux.password })).body;
    assert.deepEqual([`${view.imap.host}:${view.imap.port}`, `${view.smtp.host}:${view.smtp.port}`], [imap, smtp], preset);
  }

  const put = await api("PUT", "/settings/email", accountBody(faux));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body, { configured: true, preset: "other", address: ADDRESS, user: faux.user, imap: faux.imap, smtp: faux.smtp, password_unreadable: false });
  await meets(api, "put", "/settings/email", "200", put.body);
  assert.deepEqual((await api("GET", "/settings/email")).body, put.body);

  const tested = await api("POST", "/settings/email/test", {});
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.deepEqual(tested.body, { ok: true, imap: { ok: true, message: "Signed in to 127.0.0.1. INBOX has 2 messages." }, smtp: { ok: true, message: "Signed in to 127.0.0.1." } });
  await meets(api, "post", "/settings/email/test", "200", tested.body);
  assert.deepEqual(faux.sent(), [], "the test sends nothing");
  assert.ok(faux.commands().some((c) => /^EXAMINE "?INBOX"?/.test(c)), "INBOX opened read-only");
  assert.deepEqual(faux.messages().map((m) => m.flags), [[], []], "and left as it was");

  // The body's own account, not saved: a wrong password refused in words, nothing kept.
  const wrong = await api("POST", "/settings/email/test", { ...accountBody(faux), password: "not-a-secret" });
  assert.equal(wrong.status, 200, JSON.stringify(wrong.body));
  assert.deepEqual([wrong.body.ok, wrong.body.imap.ok, wrong.body.smtp.ok], [false, false, false]);
  assert.match(wrong.body.imap.message, /refused the sign-in/);
  assert.deepEqual((await api("GET", "/settings/email")).body, put.body, "a test saves nothing");

  // The token alone is refused every one of them: the owner's session reads and writes the account.
  const token = client(server.baseUrl, server.token);
  const bearer = { authorization: `Bearer ${server.token}` };
  for (const [method, path, body] of [["GET", "/settings/email"], ["PUT", "/settings/email", accountBody(faux)], ["POST", "/settings/email/test", {}], ["DELETE", "/settings/email"]]) {
    assert.equal((await token(method, path, body, bearer)).status, 403, `${method} ${path} with the token`);
  }

  // Nowhere in the clear: no answer, no log line, no byte of the store.
  const password = faux.password;
  for (const answer of [put, tested, wrong, gmail]) assert.ok(!JSON.stringify(answer.body).includes(password));
  assert.ok(!lines.join("\n").includes(password), "the log never holds it");
  assert.ok(!storeBytes(data).includes(Buffer.from(password)), "the store holds it sealed only");

  assert.equal((await api("DELETE", "/settings/email")).status, 204);
  assert.deepEqual((await api("GET", "/settings/email")).body, empty.body);
  const none = await api("POST", "/settings/email/test", {});
  assert.equal(none.status, 422, JSON.stringify(none.body));
  assert.match(JSON.stringify(none.body), /save one with PUT \/v2\/settings\/email/);
});

test("a server to anywhere but 127.0.0.1 is reached over TLS: 993 and 465 from the start, any other port with STARTTLS required, never in the clear", async () => {
  const { securityOf } = await import("../dist/email/account.js");
  assert.deepEqual([securityOf({ host: "imap.example.com", port: 993 }), securityOf({ host: "smtp.example.com", port: 465 })], ["tls", "tls"]);
  assert.deepEqual([securityOf({ host: "smtp.example.com", port: 587 }), securityOf({ host: "imap.example.com", port: 143 }), securityOf({ host: "smtp.example.com", port: 25 })], ["starttls", "starttls", "starttls"]);
  assert.equal(securityOf({ host: "127.0.0.1", port: 1143 }), "plaintext");
  assert.equal(securityOf({ host: "localhost", port: 1143 }), "starttls", "only the loopback address itself, never a name");
});
