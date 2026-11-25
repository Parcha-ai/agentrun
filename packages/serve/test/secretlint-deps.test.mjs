// What serve installs of secretlint, the key scan an import runs (secret-cut.ts). Since v14 the rules are part of
// @secretlint/core (`@secretlint/core/builtin`), and npm marks every rule and preset package deprecated: an install that
// pulls one prints "npm warn deprecated", the first thing a new user's `npx @parcha/agentrun` shows. So serve depends on
// none, and the profiler it switches off is the one core loads (core pins it exactly), or the switch reaches no scan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serveDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serve = JSON.parse(readFileSync(join(serveDir, "package.json"), "utf8"));

test("serve depends on no secretlint rule or preset package: the rules are core's, and npm warns on each package", () => {
  const packages = Object.keys(serve.dependencies ?? {}).filter((name) => name.startsWith("@secretlint/secretlint-rule-"));
  assert.deepEqual(packages, []);
});

test("serve pins @secretlint/profiler at the version @secretlint/core loads, so switching it off reaches every scan", () => {
  const core = JSON.parse(readFileSync(createRequire(join(serveDir, "package.json")).resolve("@secretlint/core/package.json"), "utf8"));
  assert.equal(core.version, serve.dependencies["@secretlint/core"], "the installed core is the pinned one");
  assert.equal(serve.dependencies["@secretlint/profiler"], core.dependencies["@secretlint/profiler"]);
});

test("the scan finds a key of a known format and leaves plain text alone", async () => {
  const { secretsIn } = await import("../dist/secret-cut.js");
  // A fake GitHub token: the format's prefix and length, made up.
  const fake = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;
  assert.ok((await secretsIn(`token ${fake} in a log`)).includes(fake));
  assert.deepEqual(await secretsIn("nothing secret in this line"), []);
});

// The rules the import's scan loads, by id: the recommended set but its comment filter. A secretlint bump that adds,
// drops or renames one shows here, to be read before it ships.
const LOADED = ["aws", "gcp", "privatekey", "npm", "basicauth", "slack", "sendgrid", "shopify", "stripe", "github", "gitlab", "grafana", "openai", "anthropic", "groq", "huggingface", "linear", "notion", "1password", "database-connection-string", "hashicorp-vault", "vercel", "databricks", "docker", "figma", "cloudflare", "tailscale"].map((name) => `@secretlint/secretlint-rule-${name}`);

test("the scan loads exactly the 27 recommended rules but the comment filter, in secretlint's order", async () => {
  const { SECRETLINT_RULE_IDS } = await import("../dist/secret-cut.js");
  assert.deepEqual(SECRETLINT_RULE_IDS, LOADED);
});

test("a secretlint-disable comment in what an import reads switches nothing off: the key after it is still cut", async () => {
  const { secretsIn } = await import("../dist/secret-cut.js");
  const fake = `ghp_${"Z9y8X7w6V5".repeat(3)}uvwxyz`;
  for (const comment of ["# secretlint-disable", "// secretlint-disable-next-line", "<!-- secretlint-disable -->"]) assert.ok((await secretsIn(`${comment}\n${fake}\n`)).includes(fake), comment);
});

// Real shapes, made up here: each is cut whole. A throwaway key is made for the PEM cases and never kept. Each fake is
// built when the test runs, so this file's own text holds no key (import.test.mjs imports this repository's source and
// expects nothing cut from it).
const pem = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" });
/** A PEM's key material: its base64 lines, without the BEGIN and END lines. */
const body = pem.trim().split("\n").slice(1, -1).join("\n");
const SHAPES = [
  ["slack bot token", `xoxb-${"123456".repeat(2)}-${"1234567890123"}-${"AbCdEfGhIjKl".repeat(2)}`],
  ["slack app token", `xapp-1-A${"0123456789"}-${"1234567890123"}-${"0f1e2d3c4b5a6978".repeat(4)}`],
  ["AWS secret access key", `AWS_SECRET_ACCESS_KEY=${"F4keS3cretAcc3ssK3y".padEnd(40, "0")}`, (text) => text.split("=")[1]],
  ["PEM in a JSON string", JSON.stringify({ key: pem }), () => body],
  ["GCP service-account JSON", JSON.stringify({ type: "service_account", project_id: "fake-project", private_key_id: "0123456789abcdef0123456789abcdef01234567", private_key: pem, client_email: "fake@fake-project.iam.gserviceaccount.com" }, null, 2), () => body],
];

for (const [name, text, secretOf = (whole) => whole] of SHAPES) {
  test(`cut whole: ${name}`, async () => {
    const { secretsIn } = await import("../dist/secret-cut.js");
    const found = await secretsIn(text);
    const secret = secretOf(text);
    assert.ok(found.some((value) => value.includes(secret)), `${name}: ${found.length} found, none holds the secret whole`);
  });
}
