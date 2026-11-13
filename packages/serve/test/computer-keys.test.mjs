// Settings → Computers' keys, serve side (computer-keys.ts): a provider's saved keys, by the kind registry's names, as that
// provider's create() options, and the registry's testConnection over them, its coded errors in plain words. Fakes
// only: every provider here is a stand-in, and nothing leaves the process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS } from "@parcha/agentrun-computer";
import { KEY_TABLE, keyTableOf, providerOptions, testConnection } from "../dist/computer-keys.js";

const KEY = "fake-test-key-0001";
const SECRET = "fake-test-key-secret-0002";

test("computer keys: the table is the descriptors': every provider's keys with the option each fills, its label and its settings, none written in serve", () => {
  assert.deepEqual(Object.keys(KEY_TABLE.keys).sort(), PROVIDERS.map((one) => one.id).sort());
  for (const entry of PROVIDERS) {
    assert.deepEqual(KEY_TABLE.keys[entry.id], entry.keys.map(({ name, option, required }) => ({ name, option, required })), entry.id);
    assert.equal(KEY_TABLE.labels[entry.id], entry.label, entry.id);
    assert.deepEqual(KEY_TABLE.settings[entry.id], (entry.settings ?? []).map(({ name, option, default: fallback }) => ({ name, option, ...(fallback === undefined ? {} : { default: fallback }) })), entry.id);
  }
});

test("computer keys: a provider no serve file names is mapped from its descriptor alone: its keys to its options, its setting to its default or the server's", () => {
  const table = keyTableOf([
    { id: "acme-cloud", label: "Acme Cloud", keys: [{ name: "ACME_TOKEN", option: "token", required: true }, { name: "ACME_REGION", option: "region", required: false }], settings: [{ name: "acmePool", option: "pool", default: "shared" }] },
  ]);
  assert.deepEqual(providerOptions("acme-cloud", { ACME_TOKEN: KEY }, {}, table), { ok: true, options: { token: KEY, pool: "shared" } });
  assert.deepEqual(providerOptions("acme-cloud", { ACME_TOKEN: KEY, ACME_REGION: "eu" }, { acmePool: " gold " }, table), { ok: true, options: { token: KEY, region: "eu", pool: "gold" } });
  const missing = providerOptions("acme-cloud", {}, {}, table);
  assert.match(missing.error.message, /^Acme Cloud needs ACME_TOKEN saved/);
});

test("computer keys: the saved keys become each provider's create() options; a name it does not declare is never passed on", () => {
  const cases = [
    ["docker", {}, {}],
    ["daytona", { DAYTONA_API_KEY: KEY }, { apiKey: KEY }],
    ["daytona", { DAYTONA_API_KEY: KEY, DAYTONA_API_URL: "https://daytona.example/api", DAYTONA_TARGET: "eu" }, { apiKey: KEY, apiUrl: "https://daytona.example/api", target: "eu" }],
    ["modal", { MODAL_TOKEN_ID: KEY, MODAL_TOKEN_SECRET: SECRET }, { tokenId: KEY, tokenSecret: SECRET, app: "agentrun" }],
    ["e2b", { E2B_API_KEY: KEY }, { apiKey: KEY }],
    ["orgo", { ORGO_API_KEY: KEY, ORGO_WORKSPACE_ID: "ws-1" }, { apiKey: KEY, workspaceId: "ws-1" }],
    ["phone-harness", { PHONE_HARNESS_API_KEY: KEY }, { apiKey: KEY }],
    ["browserbase", { BROWSERBASE_API_KEY: KEY, BROWSERBASE_PROJECT_ID: "proj-1" }, { apiKey: KEY, projectId: "proj-1" }],
    ["kernel", { KERNEL_API_KEY: KEY }, { apiKey: KEY }],
  ];
  for (const [id, keys, options] of cases) {
    assert.deepEqual(providerOptions(id, { ...keys, OPENAI_API_KEY: KEY, E2B_API_KEY_X: "x" }), { ok: true, options }, id);
  }
  assert.deepEqual(providerOptions("modal", { MODAL_TOKEN_ID: KEY, MODAL_TOKEN_SECRET: SECRET }, { modalApp: "acme-boxes" }), { ok: true, options: { tokenId: KEY, tokenSecret: SECRET, app: "acme-boxes" } });
  assert.deepEqual(providerOptions("daytona", { DAYTONA_API_KEY: KEY, DAYTONA_TARGET: "" }), { ok: true, options: { apiKey: KEY } }, "an empty optional key is left out");
});

test("computer keys: a required key not saved is refused in words that name what to save; an id the table does not list is no provider", () => {
  const modal = providerOptions("modal", { MODAL_TOKEN_ID: KEY });
  assert.equal(modal.ok, false);
  assert.equal(modal.error.code, "missing_key");
  assert.match(modal.error.message, /^Modal needs MODAL_TOKEN_SECRET saved: save it in Settings → Computers/);
  const bb = providerOptions("browserbase", {});
  assert.match(bb.error.message, /^Browserbase needs BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID saved: save them in Settings → Computers/);
  assert.equal(providerOptions("daytona", { DAYTONA_API_KEY: "  " }).ok, false, "a blank key is no key");
  // The table is every descriptor's: an id it does not list is refused, naming the ones it does.
  const unknown = providerOptions("vmware", { KEY });
  assert.deepEqual([unknown.ok, unknown.error.code], [false, "unsupported"]);
  assert.match(unknown.error.message, /^vmware is not a computer provider: .*\bdocker\b/);
});

/** A fake provider module: create(options) records what it was given and answers testConnection with `answer`. */
function fakeModule(answer) {
  const made = [];
  const asked = [];
  return {
    made,
    asked,
    create: async (options) => {
      made.push(options);
      return { testConnection: async (context) => { asked.push(context); return typeof answer === "function" ? answer() : answer; } };
    },
  };
}

test("computer keys: testConnection makes the provider from its options, asks it once, and passes its words through", async () => {
  const daytona = fakeModule({ ok: true, value: { detail: "Daytona answered: 2 computers of this provider" } });
  const signal = new AbortController().signal;
  const answer = await testConnection("daytona", { keys: { DAYTONA_API_KEY: KEY }, signal }, { daytona: daytona.create });
  assert.deepEqual(answer, { ok: true, value: { detail: "Daytona answered: 2 computers of this provider" } });
  assert.deepEqual(daytona.made, [{ apiKey: KEY }]);
  assert.equal(daytona.asked.length, 1);
  assert.equal(daytona.asked[0].signal, signal, "the caller's signal goes to the provider");
});

test("computer keys: each coded error comes back in plain words naming the provider, its code kept, never with a key", async () => {
  const words = {
    unauthorized: /^E2B refused the saved key: check E2B_API_KEY in Settings → Computers\. \(the vendor said: bad key \[the key\]\)$/,
    unreachable: /^E2B could not be reached: try again in a moment\. \(/,
    timeout: /^E2B could not be reached: try again in a moment\. \(/,
    aborted: /^The test of E2B was cancelled\.$/,
    refused: /^E2B refused the request\. \(/,
    denied: /^E2B refused the request\. \(/,
    limit: /^E2B says the account is at a limit\. \(/,
    invalid: /^E2B's settings are not valid\. \(/,
    unsupported: /^E2B can't be tested here\. \(/,
    vendor: /^E2B answered with an error\. \(/,
    // A code with no words of its own (gone, not_found, exists, ...) is a failed test, in general words; so is a
    // per-vendor code the package no longer makes (e2b): it has no case of its own.
    e2b: /^The test of E2B failed\. \(/,
    gone: /^The test of E2B failed\. \(/,
    not_found: /^The test of E2B failed\. \(/,
  };
  for (const [code, pattern] of Object.entries(words)) {
    const module = fakeModule({ ok: false, error: { code, message: `bad key ${KEY}` } });
    const answer = await testConnection("e2b", { keys: { E2B_API_KEY: KEY } }, { e2b: module.create });
    assert.equal(answer.ok, false, code);
    assert.equal(answer.error.code, code, "the code is kept");
    assert.match(answer.error.message, pattern, code);
    assert.ok(!answer.error.message.includes(KEY), `${code}: no key in the words`);
  }
});

test("computer keys: a provider that cannot be made, or that throws, is a failed test in words; a detail holding a key is scrubbed", async () => {
  const throwing = { modal: async () => { throw new Error(`the Modal provider refuses ${SECRET}`); } };
  const made = await testConnection("modal", { keys: { MODAL_TOKEN_ID: KEY, MODAL_TOKEN_SECRET: SECRET } }, throwing);
  assert.deepEqual([made.ok, made.error.code], [false, "invalid"]);
  assert.match(made.error.message, /^Modal's settings are not valid\. \(the vendor said: the Modal provider refuses \[the key\]\)$/);
  const exploding = fakeModule(() => { throw new Error(`socket closed near ${KEY}`); });
  const thrown = await testConnection("orgo", { keys: { ORGO_API_KEY: KEY, ORGO_WORKSPACE_ID: "ws-1" } }, { orgo: exploding.create });
  assert.deepEqual([thrown.ok, thrown.error.code], [false, "unreachable"]);
  assert.ok(!thrown.error.message.includes(KEY));
  const leaky = fakeModule({ ok: true, value: { detail: `token ${KEY} works` } });
  const ok = await testConnection("kernel", { keys: { KERNEL_API_KEY: KEY } }, { kernel: leaky.create });
  assert.deepEqual(ok, { ok: true, value: { detail: "token [the key] works" } });
});

test("computer keys: a provider with no module on this server, or keys missing, answers before anything is made", async () => {
  const daytona = fakeModule({ ok: true, value: { detail: "unused" } });
  const missing = await testConnection("daytona", { keys: {} }, { daytona: daytona.create });
  assert.deepEqual([missing.ok, missing.error.code], [false, "missing_key"]);
  assert.deepEqual(daytona.made, [], "nothing was made without its key");
  for (const id of ["browserbase", "kernel"]) {
    const keys = id === "browserbase" ? { BROWSERBASE_API_KEY: KEY, BROWSERBASE_PROJECT_ID: "p" } : { KERNEL_API_KEY: KEY };
    const answer = await testConnection(id, { keys }, {});
    assert.deepEqual([answer.ok, answer.error.code], [false, "unsupported"]);
    assert.match(answer.error.message, /connection test isn't available on this server yet/);
  }
  const noTest = await testConnection("docker", { keys: {} }, { docker: async () => ({}) });
  assert.deepEqual([noTest.ok, noTest.error.code], [false, "unsupported"]);
});
