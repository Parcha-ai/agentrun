// The fake mail account (src/email/email-faux.ts) is runtime code, kept for template-eval.ts's evals, and the server's real
// email path never reaches it: the account routes name no fake (no preset or field picks one), the fake's own servers by
// any name but 127.0.0.1 are not reached in the clear, and no server file but template-eval.ts imports it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { serve, withEnv } from "./support.mjs";
import { accountBody, mailbox } from "./email-support.mjs";

const SRC = new URL("../src/", import.meta.url).pathname;
/** The server files that may import the fake: the template evals, which run an agent against it. */
const MAY_IMPORT = new Set(["template-eval.ts"]);

test("the account routes refuse the fake: no preset or field names it, and its servers by a name are not reached in the clear", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { runner: false });
  const faux = await mailbox(t);
  for (const [path, method] of [["/settings/email", "PUT"], ["/settings/email/test", "POST"]]) {
    const named = await api(method, path, accountBody(faux, { preset: "faux" }));
    assert.equal(named.status, 422, `${method} ${path}: ${JSON.stringify(named.body)}`);
    assert.deepEqual(named.body.error.fields.map((f) => [f.field, f.reason]), [["preset", "not_an_option"]]);
    const flagged = await api(method, path, accountBody(faux, { faux: true }));
    assert.equal(flagged.status, 422, `${method} ${path}: ${JSON.stringify(flagged.body)}`);
    assert.deepEqual(flagged.body.error.fields.map((f) => f.field), ["faux"]);
  }
  // By name the fake is a server like any other: TLS is required of it, which it never offers, so it is never signed in to.
  const byName = accountBody(faux, { imap: { host: "localhost", port: faux.imap.port }, smtp: { host: "localhost", port: faux.smtp.port } });
  const tested = await api("POST", "/settings/email/test", byName);
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.deepEqual([tested.body.ok, tested.body.imap.ok, tested.body.smtp.ok], [false, false, false], JSON.stringify(tested.body));
});

test("no server file but template-eval.ts imports the fake mail account", () => {
  const files = readdirSync(SRC, { recursive: true }).filter((name) => /\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts"));
  assert.ok(files.length > 100, `read the server's files: ${files.length}`);
  const importers = files.filter((name) => {
    const code = readFileSync(join(SRC, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*email-faux(?:\.[cm]?[jt]s)?["']/.test(code);
  }).map((name) => relative(SRC, join(SRC, name)));
  assert.deepEqual(importers.filter((name) => !MAY_IMPORT.has(name)), [], "only the template evals import it");
  assert.ok(!importers.includes("email/email-faux.ts"));
});
