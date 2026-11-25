// The providers a run's end names as ending their own machines (run-end-computers.ts VENDOR_ENDS_ITS_OWN, said in its
// line when it can't read the run) are kept by hand. This holds that list to the registry the computer janitor reads
// (the computer package's PROVIDERS): each provider is built as the janitor builds it (providerOptions, then
// providerFor), with dummy keys and no vendor call, and its capabilities().lifetime asked. Every provider whose lifetime
// is "vendor" is named in the line, and no other is, so a provider added to the registry can't be missed. A provider
// that can't be built here fails the test in words that name it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDERS, providerFor } from "@parcha/agentrun-computer";

const { runEndComputers } = await import("../dist/workspace/run-end-computers.js");
const { providerOptions } = await import("../dist/computer-keys.js");

/** A dummy value for the key `name`, of the shape its provider's create() checks: a URL, an SSH private key's armour, or
 *  a word of lowercase letters and a hyphen (an API key, a token, an app's name). */
const dummy = (name) => (/_URL$/.test(name) ? "https://example.invalid" : /SSH_KEY$/.test(name) ? "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n" : "test-value");

/** Each registered provider's label and lifetime, built with a dummy value for each key it requires. Docker's create
 *  asks the docker CLI for the host's architecture unless it is handed a daemon path: it is handed one, so no Docker
 *  is run. */
async function lifetimes() {
  const out = [];
  for (const entry of PROVIDERS) {
    const keys = Object.fromEntries(entry.keys.filter((key) => key.required).map((key) => [key.name, dummy(key.name)]));
    const options = providerOptions(entry.id, keys);
    assert.ok(options.ok, `${entry.id}'s options from dummy keys: ${JSON.stringify(options)}`);
    const given = entry.id === "docker" ? { ...options.options, daemonPath: "/nonexistent/agentrun-daemon" } : options.options;
    const provider = await providerFor(entry.id, given).catch((error) => assert.fail(`${entry.id} could not be built to read its lifetime: ${error instanceof Error ? error.message : String(error)}`));
    out.push({ id: entry.id, label: entry.label, lifetime: provider.capabilities().lifetime });
  }
  return out;
}

/** The providers a run's end names in its line when it can't read the run, lowercased, a leading "the " dropped. */
async function named() {
  const said = [];
  const store = {
    runs: {
      get: async () => {
        throw new Error("the store did not answer");
      },
      launch: async () => assert.fail("a run that can't be read has no launch asked"),
    },
  };
  await runEndComputers({ store, computers: { kinds: { PROVIDERS }, providers: {} }, log: (line) => said.push(line) })({ runId: "run-1", epoch: 2 });
  assert.equal(said.length, 1, `one line: ${JSON.stringify(said)}`);
  const list = /\(on (.+) it ends only a machine a park kept/.exec(said[0])?.[1];
  assert.ok(list, `the line names the providers whose vendor ends its own machines: ${said[0]}`);
  return list.split(/, | or /).map((name) => name.toLowerCase().replace(/^the /, ""));
}

test("a run's end names every provider whose lifetime is the vendor's, by the registry's labels, and no other", async () => {
  const registry = await lifetimes();
  assert.ok(registry.some((one) => one.lifetime === "vendor") && registry.some((one) => one.lifetime === "janitor"), `the registry has providers of both lifetimes: ${JSON.stringify(registry)}`);
  for (const one of registry) assert.ok(one.lifetime === "vendor" || one.lifetime === "janitor", `${one.id}'s lifetime is vendor or janitor: ${one.lifetime}`);
  const vendor = registry.filter((one) => one.lifetime === "vendor").map((one) => one.label.toLowerCase());
  const names = await named();
  const missing = vendor.filter((label) => !names.includes(label));
  const extra = names.filter((name) => !vendor.includes(name));
  assert.deepEqual(missing, [], `every provider whose vendor ends its own machines is named in the run's end's line (VENDOR_ENDS_ITS_OWN), missing: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `no provider the janitor sweeps (lifetime "janitor"), and no name the registry doesn't have, is named there, named: ${extra.join(", ")}`);
  assert.equal(new Set(names).size, names.length, `each is named once: ${names.join(", ")}`);
});
