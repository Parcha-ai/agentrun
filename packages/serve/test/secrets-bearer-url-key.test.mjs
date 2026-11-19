// Two shapes of secret a run's views show of no value the server holds: the token after a `Bearer` scheme, and the
// value of a URL parameter named like a credential (`?api_key=`, `&access_token=`, a signed URL's `sig=`). Each is cut
// where it stands, its label kept, so a reader still sees which header or parameter held it. A word after "bearer"
// that is no token, a placeholder, and a parameter that only resembles a credential's name are left as written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redacted, redactedAnswer } from "../dist/key-refusal.js";
import { redactSecrets, secretShapes } from "../dist/learn/secrets.js";
import { traceSpans } from "../dist/run-trace.js";
import { timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-lib-support.mjs";

// Made at run time: no credential-shaped literal for the source export.
const TOKEN = ["qa", "Opaque", "Token", "0000", "1111", "2222", "3333"].join("");
const PADDED = `${["QUJD", "REVG", "R0hJ", "SktM", "TU5P", "MTIz", "NDU2"].join("")}==`;
const VALUE = ["qa", "Query", "Value", "0000", "1111", "2222"].join("");
const SCHEME = ["Bea", "rer"].join("");
const cut = (text) => redactSecrets(text, []);

test("the token after a Bearer scheme is cut and its header kept, however the scheme is written", () => {
  assert.equal(cut(`Authorization: ${SCHEME} ${TOKEN}`), `Authorization: ${SCHEME} [redacted]`);
  assert.equal(cut(`authorization: ${SCHEME.toLowerCase()} ${TOKEN}`), `authorization: ${SCHEME.toLowerCase()} [redacted]`);
  assert.equal(cut(`curl -H "Authorization: ${SCHEME} ${TOKEN}" https://api.example/v1`), `curl -H "Authorization: ${SCHEME} [redacted]" https://api.example/v1`);
  assert.equal(cut(JSON.stringify({ headers: { authorization: `${SCHEME} ${PADDED}` } })), `{"headers":{"authorization":"${SCHEME} [redacted]"}}`);
  assert.deepEqual(secretShapes(`${SCHEME} ${TOKEN}`), ["bearer token"]);
});

test("a word after bearer that is no token is left as written", () => {
  const plain = [
    `Authorization: ${SCHEME} <token>`,
    `Authorization: ${SCHEME} $AGENTRUN_API_KEY`,
    `Authorization: ${SCHEME} YOUR_API_KEY`,
    `The API takes ${SCHEME.toLowerCase()} authentication/authorization headers.`,
    `www-authenticate: ${SCHEME} realm="example"`,
    `www-authenticate: ${SCHEME} resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"`,
    `The ${SCHEME.toLowerCase()} of this note signed on 2026-11-19.`,
  ];
  for (const text of plain) {
    assert.equal(cut(text), text);
    assert.deepEqual(secretShapes(text), [], text);
  }
});

test("the value of a URL parameter named like a credential is cut and its name kept", () => {
  assert.equal(cut(`https://api.example/x?api_key=${VALUE}`), "https://api.example/x?api_key=[redacted]");
  assert.equal(cut(`GET https://api.example/x?page=2&access_token=${VALUE}&sort=asc done`), "GET https://api.example/x?page=2&access_token=[redacted]&sort=asc done");
  assert.equal(cut(`https://bucket.example/file.pdf?X-Amz-Expires=300&X-Amz-Signature=${VALUE}`), "https://bucket.example/file.pdf?X-Amz-Expires=300&X-Amz-Signature=[redacted]");
  assert.equal(cut(`https://blob.example/c/f?sv=2026-01-01&sig=${encodeURIComponent(`${PADDED}/+`)}`), "https://blob.example/c/f?sv=2026-01-01&sig=[redacted]");
  assert.equal(cut(`grant_type=refresh_token&client_secret=${VALUE}&refresh_token=${TOKEN}`), "grant_type=refresh_token&client_secret=[redacted]&refresh_token=[redacted]");
  for (const name of ["apikey", "api-key", "auth_token", "id_token", "token", "secret", "password", "signature"]) {
    assert.equal(cut(`https://api.example/x?${name}=${VALUE}`), `https://api.example/x?${name}=[redacted]`, name);
  }
  assert.deepEqual(secretShapes(`https://api.example/x?api_key=${VALUE}`), ["URL parameter named like a credential"]);
});

test("a parameter that only resembles a credential's name, or holds a short value, is left as written", () => {
  const plain = [
    `https://api.example/list?page_token=${VALUE}`,
    `https://api.example/list?sort_key=${VALUE}`,
    `https://files.example/get?key=uploads/2026/quarterly-report-final.pdf`,
    "https://api.example/x?token=abc123",
    "https://api.example/x?sort=signature_descending_order",
    "Set token=the-value-you-were-given in the form.",
  ];
  for (const text of plain) {
    assert.equal(cut(text), text);
    assert.deepEqual(secretShapes(text), [], text);
  }
});

test("both shapes are read in linear time on a text made to be slow", () => {
  const hostile = [
    `${SCHEME} ${"a".repeat(4_000)} `.repeat(60),
    `${SCHEME}${" ".repeat(4_000)}`.repeat(60),
    `?token=${"=".repeat(4_000)}&`.repeat(60),
    `${`&sig=${"a".repeat(15)}`.repeat(4_000)}`,
  ];
  for (const text of hostile) {
    const began = performance.now();
    redactSecrets(text, [], 1 << 20);
    const took = performance.now() - began;
    assert.ok(took < 500, `took ${Math.round(took)} ms on ${JSON.stringify(text.slice(0, 24))}`);
  }
});

test("a URL whose credential's value holds more parameters of the same name is read once, not once from each", () => {
  // The value runs to the next separator and may hold "?" and "=", so every nested "?token=" starts a match that ends
  // where the first does. Read from each, 128 KB took over a second.
  const nested = "?token=a".repeat(16_000);
  const began = performance.now();
  const out = redactSecrets(nested, [], 1 << 20);
  const took = performance.now() - began;
  assert.equal(out, "?token=[redacted]");
  assert.ok(took < 300, `took ${Math.round(took)} ms`);
});

test("a long answer shows no Bearer token wherever its pieces are cut: the scheme and its token are read together", () => {
  // An answer is redacted in pieces of about 8 KB cut at whitespace (redactedAnswer). The token follows whitespace, so
  // a cut there would leave the scheme at the end of one piece and the token at the head of the next, read by neither.
  for (const header of [`Authorization: ${SCHEME} ${TOKEN}`, `{"authorization":"${SCHEME} ${TOKEN}"}`, `${SCHEME}   ${TOKEN}`]) {
    for (let pad = 8_140; pad <= 8_200; pad++) {
      const out = redactedAnswer(`${"x".repeat(pad)} ${header} and the rest of the answer.`, []);
      assert.ok(!out.includes(TOKEN), `${pad} characters before ${JSON.stringify(header)}`);
      assert.ok(out.endsWith(`${header.replace(TOKEN, "[redacted]")} and the rest of the answer.`), `${pad}: ${out.slice(-90)}`);
    }
  }
  // No whitespace before the scheme to cut at instead: the scheme and its token are read as one piece, and one longer
  // than a piece is shown as "[redacted]", as any run of that length with no whitespace is.
  const long = ["a1", "B2"].join("").repeat(2_047);
  assert.ok(!redactedAnswer(`k:${SCHEME} ${long} end`, []).includes(long.slice(0, 20)));
});

test("a run's trace shows neither: a tool call's input and result previews are cut of both, as its Timeline rows are", () => {
  // The address is no whole URL (its host is a shell variable), so the Timeline's own URL scrub (scrubUrls, which shows
  // no absolute URL's query on a call's rows) does not read it: only the shape hides its key.
  const said = `curl -H "Authorization: ${SCHEME} ${TOKEN}" "$BASE/v1/items?api_key=${VALUE}"`;
  const entries = [user("Call the API."), assistant([call("c1", "bash", { command: said })]), result("c1", "bash", `ran: ${said}`), assistant([{ type: "text", text: `Done: ${said}` }], 1)];
  // Serve's own rule over no held value (run-timeline-served.ts): only the shapes are cut.
  const rows = timelineOf(entries, { redact: (text) => redacted(text, []), settled: true });
  const span = traceSpans(rows, entries).spans.find((s) => s.tool_use_id === "c1");
  assert.ok(span, JSON.stringify(rows.map((r) => r.kind)));
  const shown = JSON.stringify({ rows, span });
  assert.ok(!shown.includes(TOKEN) && !shown.includes(VALUE), shown);
  // The scheme and the parameter's name are kept, so a reader still sees what the call sent.
  for (const preview of [span.input_preview, span.result_preview]) assert.match(preview, new RegExp(`${SCHEME} \\[redacted\\].*api_key=\\[redacted\\]`));
});
