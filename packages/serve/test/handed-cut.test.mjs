// What the server writes of a start or a message is cut of the values handed with it (handed-values.ts cutHanded), and a
// value a message replaces mid-turn stays sealed as `retired`, only to be cut, until the turn's end erases the seal; a
// message that seals over bytes that don't open, or past RETIRED_MAX values, marks the launch `lost`, whose values read
// as unreadable (the run withheld).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { cutHanded, handedSecretValues, launchValuesOf, RETIRED_MAX, retiredValues } from "../dist/handed-values.js";
import { launchSecrets } from "../dist/runner/store-secrets.js";
import { openRunLaunch, sealRunLaunch } from "../dist/store/seal.js";

const KEY = `not-a-secret-${"handed-unit-model-key"}-7c1e40`;
const TOOL = `not-a-secret-${"handed-unit-tool-key"}-19ab02`;
const ORIGIN = "https://gateway.example";

test("cutHanded cuts each handed value from every string in a body, nested and past multibyte text, and nothing else", () => {
  const values = handedSecretValues({ model: KEY, keys: { TOOL_KEY: TOOL } });
  assert.ok(values.includes(KEY) && values.includes(TOOL), "the model key and each tool key");
  const body = { input: { content: `ñandú → ${KEY} ✓`, parts: [`tool ${TOOL}`, 3, null, true] }, effort: "high", title_hint: `not-a-secret-${"never-handed-value"}-4d21aa` };
  assert.deepEqual(cutHanded(body, values), { input: { content: "ñandú → [redacted] ✓", parts: ["tool [redacted]", 3, null, true] }, effort: "high", title_hint: `not-a-secret-${"never-handed-value"}-4d21aa` }, "a value never handed is not cut: only what was handed");
  assert.equal(cutHanded(`as JSON: ${JSON.stringify(KEY)}`, values), "as JSON: \"[redacted]\"");
  assert.equal(cutHanded("unchanged", []), "unchanged", "nothing handed: as given");
  assert.deepEqual(handedSecretValues({}), [], "a start that hands nothing");
});

test("retiredValues lists what a message's seal no longer holds, earlier retired values too, and drops a value handed again", () => {
  const before = { model: { key: KEY, origin: ORIGIN }, keys: { TOOL_KEY: TOOL } };
  assert.deepEqual(retiredValues(before, { model: { key: "not-a-secret-the-next-key-000000", origin: ORIGIN }, keys: { TOOL_KEY: TOOL } }), [KEY]);
  assert.deepEqual(retiredValues({ ...before, retired: ["not-a-secret-older-key-111111"] }, before), ["not-a-secret-older-key-111111"], "an earlier retired value stays");
  assert.deepEqual(retiredValues({ retired: [KEY] }, before), [], "handed again: held, not retired");
  assert.equal(RETIRED_MAX, 256);
});

test("a launch seal keeps retired values and the lost mark: the runner's cut lists the retired ones, and a lost launch's values are unreadable", () => {
  const key = randomBytes(32);
  const sealed = sealRunLaunch(key, "run_1", { model: { key: "not-a-secret-the-next-key-000000", origin: ORIGIN }, retired: [KEY] });
  assert.deepEqual(openRunLaunch(key, "run_1", sealed).retired, [KEY]);
  assert.ok(launchValuesOf(key, "run_1", sealed).includes(KEY), "a served read cuts it");
  assert.ok(launchSecrets(JSON.stringify({ retired: [KEY] })).includes(KEY), "the runner's cut lists it");
  const lost = sealRunLaunch(key, "run_1", { model: { key: "not-a-secret-the-next-key-000000", origin: ORIGIN }, lost: true });
  assert.equal(openRunLaunch(key, "run_1", lost).lost, true);
  assert.equal(launchValuesOf(key, "run_1", lost), "unreadable", "what it held is not known: the run is withheld");
  assert.notEqual(sealRunLaunch(key, "run_1", { lost: true }), null, "a lost mark alone is still sealed");
  assert.equal(sealRunLaunch(key, "run_1", { retired: [] }), null, "nothing held, nothing retired: no seal");
});

test("a handed MCP header's credential is cut alone, whatever its scheme: a Basic one, the user:password it encodes and the password too", () => {
  const password = `not-a-secret-${"basic-password"}-3f9d`;
  const basic = Buffer.from(`agent-user:${password}`).toString("base64");
  const values = handedSecretValues({ mcp: { files: { headers: { authorization: `Basic ${basic}`, "x-api-key": `Token not-a-secret-${"token-scheme"}-88e1` }, origin: ORIGIN } } });
  assert.ok(values.includes(basic), "the Basic credential");
  assert.ok(values.includes(password), "the password it encodes");
  assert.ok(values.includes(`not-a-secret-${"token-scheme"}-88e1`), "another scheme's credential");
  assert.equal(cutHanded(`curl -H "Authorization: Basic ${basic}" and -u agent-user:${password}`, values), `curl -H "Authorization: Basic [redacted]" and -u [redacted]`);
  const launch = launchValuesOf(Buffer.alloc(32, 7), "run_1", sealRunLaunch(Buffer.alloc(32, 7), "run_1", { mcp: { files: { headers: { authorization: `Basic ${basic}` }, origin: ORIGIN } } }));
  assert.ok(launch.includes(basic) && launch.includes(password), "a served read and the end's census list them from the launch");
});

test("a handed Bearer header's token is cut alone, whichever case the scheme is written in", () => {
  for (const scheme of ["Bearer", "bearer"]) {
    const token = `not-a-secret-${"bearer-token"}-${scheme}-41c7`;
    const values = handedSecretValues({ mcp: { files: { headers: { authorization: `${scheme} ${token}` }, origin: ORIGIN } } });
    assert.ok(values.includes(token), `the ${scheme} token`);
    assert.equal(cutHanded(`H: ${scheme} ${token} and TOKEN=${token}`, values), `H: ${scheme} [redacted] and TOKEN=[redacted]`, `the ${scheme} token is cut with or without its scheme word`);
  }
});

test("a Basic credential with its key as the user, or with no user, has the key listed alone; a header that names no scheme is never split", () => {
  const key = `not-a-secret-${"basic-user-key"}-6a20`;
  const asUser = handedSecretValues({ mcp: { files: { headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` }, origin: ORIGIN } } });
  assert.ok(asUser.includes(key), "-u KEY: lists the key, the user, alone");
  assert.equal(cutHanded(`KEY=${key}`, asUser), "KEY=[redacted]");
  const shortPassword = handedSecretValues({ mcp: { files: { headers: { authorization: `Basic ${Buffer.from(`${key}:x`).toString("base64")}` }, origin: ORIGIN } } });
  assert.ok(shortPassword.includes(key), "a password too short to be the secret: the user is");
  const noUser = handedSecretValues({ mcp: { files: { headers: { authorization: `Basic ${Buffer.from(`:${key}`).toString("base64")}` }, origin: ORIGIN } } });
  assert.ok(noUser.includes(key), ":KEY lists the key, the password, alone");
  const apiKey = handedSecretValues({ mcp: { files: { headers: { "x-auth": `ApiKey ${key}` }, origin: ORIGIN } } });
  assert.ok(apiKey.includes(key), "an ApiKey scheme's credential");
  const named = handedSecretValues({ mcp: { files: { headers: { "x-client": "Acme Integration", authorization: `Bearer ${key}` }, origin: ORIGIN } } });
  assert.equal(named.includes("Integration"), false, "a client's name is no scheme: no word of it is listed");
  assert.equal(cutHanded("the Acme Integration client", named), "the Acme Integration client");
});

// A header in a scheme the list doesn't name (Okta's `SSWS`, Discord's `Bot`, `OAuth`, `Splunk`, `GenieKey`,
// `Zoho-oauthtoken`, `Klaviyo-API-Key`, `Api-Key`) still has its credential listed alone when that word is shaped like
// one, so a run that prints the token bare is cut. Each value below trips exactly one shape: a digit, 20 characters or
// more, base64 punctuation, mixed case past the first letter, or hex letters at MIN_SECRET or more. A client's name
// trips none and is never split.
test("a header in an unlisted scheme has its credential listed alone when the word is shaped like one; a client's name is not split", () => {
  const shaped = [
    ["SSWS", "00notasecret", "a digit"],
    ["Bot", "notasecretdiscordbottoken", "20 characters or more"],
    ["OAuth", "notsecret+ab/=", "base64 punctuation"],
    ["Splunk", "notASecretTok", "mixed case past the first letter"],
    ["GenieKey", "deadbeefcafe", "hex letters at MIN_SECRET or more"],
    ["Zoho-oauthtoken", "1000.notasecret", "a hyphenated scheme, with a digit"],
    ["Klaviyo-API-Key", "pk_notasecret01", "a hyphenated scheme, with a digit"],
    ["Api-Key", "notasecretapikeyvalue", "a hyphenated scheme, 20 characters or more"],
  ];
  for (const [scheme, token, why] of shaped) {
    const values = handedSecretValues({ mcp: { files: { headers: { "x-auth": `${scheme} ${token}` }, origin: ORIGIN } } });
    assert.ok(values.includes(token), `${scheme}: ${why}`);
    assert.equal(cutHanded(`printed ${token} bare`, values), "printed [redacted] bare", `${scheme}: ${why}`);
  }
  for (const name of ["Acme Integration", "Acme integration-service", "Partner Program"]) {
    const values = handedSecretValues({ mcp: { files: { headers: { "x-client": name }, origin: ORIGIN } } });
    const word = name.split(" ")[1];
    assert.equal(values.includes(word), false, `${name}: a client's name, no word of it listed`);
    assert.equal(cutHanded(`the ${name} client`, values), `the ${name} client`);
  }
});
