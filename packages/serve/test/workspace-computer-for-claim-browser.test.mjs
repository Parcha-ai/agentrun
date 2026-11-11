// A Browser computer at its claim (computer-for-claim.ts), with no launch of the server's own: the claim makes nothing.
// It gives the run's browser tool the provider (ClaimBrowser), through which the tool opens each session at its call,
// under the run's labels and its tag, reads its CDP URL through the provider's connect at each attach, and releases it
// when it lets go, so a session lives, and is booked, only while the tool holds it. The claim's release lets go of any
// session the tool left open. Before, every such claim was refused ("it gave no CDP connection"). Browserbase, Kernel
// and the local Chrome take the one path; each provider is a stand-in in the computer module's shape. And the browser
// tool's provider over it (browser-computer.ts): its target dials the provider's URL; a session the provider says is
// gone reads as gone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { claimBrowserProvider } from "../dist/browser-computer.js";
import { putSealedKey } from "../dist/server-keys.js";
import { computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** A browser provider in the computer module's shape: each create a session under its labels, its connect handing over
 *  `url` as its CDP target (as Browserbase's, Kernel's and the local Chrome's do) or `gone` once it has ended. */
function browserProvider(id, url, record) {
  return {
    id,
    version: "0",
    capabilities: () => ({ lifetime: "vendor", maxLifetimeMs: 3_600_000, network: ["open"], groups: ["cdp"] }),
    check: () => [],
    async list(labels) {
      const held = record.created.filter((one) => !record.released.some(([released]) => released === one.id) && Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.id }, labels: one.labels, state: "running", network: "open" })) };
    },
    async create(spec) {
      const made = `${id}-${record.created.length + 1}`;
      record.created.push({ id: made, labels: spec.labels, lifetimeMs: spec.lifetimeMs });
      return { ok: true, value: { id: made, name: made } };
    },
    async connect(ref) {
      record.connects += 1;
      if (record.released.some(([released]) => released === ref.id)) return { ok: false, error: { code: "gone", message: `the ${id} session ${ref.id} has ended` } };
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
  test(`a ${provider} browser computer: the claim makes nothing; the browser tool opens, attaches to and releases each session through its provider, and the claim's release lets go of what it left`, async () => {
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
    const spec = () => ({ image: "browser", lifetimeMs: 600_000, network: "open" });

    const answer = await computerForClaim({ runId: "run-1", epoch: 2, computer: { kind: "browser", provider } }, store, { mode: 1, kinds: KINDS, sealKey, providers, spec, workspace: localWorkspace(root), check: { readBackOf, epoch: 2 } });
    assert.equal(answer.computer?.kind, "browser");
    assert.deepEqual(record.created, [], "the claim makes no session");
    const sessions = claimBrowserProvider(answer.computer.browser);
    assert.equal(sessions.name, provider);
    assert.equal(sessions.caps.maxLifetimeS, 600);

    // The tool's first call: a session under the run's labels and its tag, living no longer than custody asks.
    const first = await sessions.create({ tag: "ar-run-1-1", maxLifetimeS: 120 }, new AbortController().signal);
    assert.deepEqual(first, { id: `${provider}-1`, tag: "ar-run-1-1" });
    assert.deepEqual(record.created, [{ id: `${provider}-1`, labels: { "agentrun.run": "run-1", "agentrun.epoch": "2", "agentrun.session": "ar-run-1-1" }, lifetimeMs: 120_000 }]);
    assert.deepEqual(await sessions.findByTag("ar-run-1-1"), [first], "a create whose answer was lost is found by its tag");
    const atStart = record.connects;
    const target = await sessions.attach(first);
    assert.equal(record.connects, atStart + 1, "each attach asks the provider's connect");
    assert.equal(target.sdkCdpUrl, url, "the driver and the live view dial the URL the provider handed over");
    assert.equal(await sessions.status(first), "running");

    // The tool lets it go: the computer is released then, not at the run's end.
    await sessions.release(first);
    assert.deepEqual(record.released, [[`${provider}-1`, "delete"]]);
    assert.equal(await sessions.status(first), "gone", "a session its provider says has ended is gone");

    // A session the tool left open is let go with the claim, once.
    const second = await sessions.create({ tag: "ar-run-1-2", maxLifetimeS: 6_000 }, new AbortController().signal);
    assert.equal(record.created[1].lifetimeMs, 600_000, "never past the computer's own lifetime");
    await answer.release();
    await answer.release();
    assert.deepEqual(record.released, [[`${provider}-1`, "delete"], [second.id, "delete"]]);
  });
}
