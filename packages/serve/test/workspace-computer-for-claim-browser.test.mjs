// A Browser computer at its claim through the providers' own path (computer-for-claim.ts providerLaunch), with no
// launch of the server's own: the claim's computer is what the run's browser tool drives it by, its id, its provider and
// its CDP URL, read through the provider's connect at each attach. Before, every such claim was refused ("it gave no CDP
// connection"), since only a test's launch gave one. Browserbase, Kernel and the local Chrome take the one path; each
// provider is a stand-in in the computer module's shape. And the run's browser tool's provider over it
// (browser-computer.ts): its target dials the signed URL and shows none of its query; a session the provider says is
// gone reads as gone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { claimBrowserProvider, claimBrowserTarget } from "../dist/browser-computer.js";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A browser provider in the computer module's shape: its connect hands over `url` as its CDP target, as Browserbase's,
 *  Kernel's and the local Chrome's do, or `gone` once the session has ended. Dials nothing itself. */
function browserProvider(id, url, record) {
  return {
    id,
    version: "0",
    capabilities: () => ({ lifetime: "vendor", maxLifetimeMs: 3_600_000, network: ["open"], groups: ["cdp"] }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(spec.labels);
      return { ok: true, value: { id: `${id}-1`, name: `${id}-1` } };
    },
    async connect() {
      record.connects += 1;
      if (record.ended) return { ok: false, error: { code: "gone", message: `the ${id} session ${id}-1 has ended` } };
      return { ok: true, value: { client: { close() {} }, hello: { version: "0", kind: "browser", groups: ["cdp"] }, cdp: { url }, close: async () => {} } };
    },
    attach: async () => ({ ok: false, error: { code: "unsupported", message: "nothing is mounted in this computer" } }),
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
}

for (const [provider, keys, url] of [
  ["browserbase", { BROWSERBASE_API_KEY: "bb-test", BROWSERBASE_PROJECT_ID: "proj-test" }, "wss://connect.browserbase.test/?signingKey=SECRET-bb"],
  ["kernel", { KERNEL_API_KEY: "kn-test" }, "wss://cdp.kernel.test/browser/k1?jwt=SECRET-kn"],
  ["local", {}, "ws://127.0.0.1:9222/devtools/browser/abc"],
]) {
  test(`a ${provider} browser computer made through its provider (no launch of the server's) is driven by the CDP URL its provider's connect hands over, read again at each attach`, async () => {
    const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-claim-browser-")));
    dirs.push(dir);
    const root = join(dir, "work");
    mkdirSync(root);
    const sealed = new Map();
    const store = {
      agents: { revision: async () => undefined },
      sealedKeys: { get: async (name) => sealed.get(name), put: async (name, value) => void sealed.set(name, value), remove: async (name) => void sealed.delete(name), all: async () => [...sealed].map(([name]) => ({ name })) },
      computerLedger: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} },
    };
    const sealKey = randomBytes(32);
    for (const [name, value] of Object.entries(keys)) await putSealedKey(store, sealKey, name, value);
    const record = { created: [], released: [], connects: 0 };
    const providers = { [provider]: () => browserProvider(provider, url, record) };
    const spec = () => ({ image: "browser", lifetimeMs: 60_000, network: "open" });

    const answer = await computerForClaim({ runId: "run-1", epoch: 2, computer: { kind: "browser", provider } }, store, { mode: 1, kinds: KINDS, sealKey, providers, spec, workspace: localWorkspace(root), check: { readBackOf, epoch: 2 } });
    assert.equal(answer.computer?.kind, "browser");
    assert.deepEqual(record.created, [{ "agentrun.run": "run-1", "agentrun.epoch": "2" }]);
    const { browser } = answer.computer;
    assert.deepEqual([browser.id, browser.provider], [`${provider}-1`, provider]);
    const atStart = record.connects;
    const target = await claimBrowserTarget(browser);
    assert.equal(record.connects, atStart + 1, "each attach asks the provider's connect");
    assert.equal(target.dial.url, url, "the driver dials the URL the provider handed over");
    assert.ok(!target.sdkCdpUrl.includes("SECRET") && !target.sdkCdpUrl.includes("?"), `the target shows none of its query: ${target.sdkCdpUrl}`);
    const sessions = await claimBrowserProvider(browser);
    assert.equal(sessions.name, provider);
    assert.equal(await sessions.status({ id: browser.id, tag: "t" }), "running");
    record.ended = true;
    assert.equal(await sessions.status({ id: browser.id, tag: "t" }), "gone", "a session its provider says has ended is gone");
    await answer.release();
    assert.deepEqual(record.released, [[`${provider}-1`, "delete"]]);
  });
}
