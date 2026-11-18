// Each provider's descriptor's mounts, with the synced folder they derive (mountsOf), are what its provider declares:
// capabilities().mount, or none, on its fake. A caller reads the descriptor to tell which provider binds a local folder
// without building one, so the two never disagree.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { DAYTONA } from "../dist/descriptors/daytona.js";
import { DOCKER } from "../dist/descriptors/docker.js";
import { E2B } from "../dist/descriptors/e2b.js";
import { MODAL } from "../dist/descriptors/modal.js";
import { E2BProvider } from "../dist/e2b.js";
import { mountsOf } from "../dist/index.js";
import { ModalProvider } from "../dist/modal.js";
import { fakeDocker } from "./fake-docker.mjs";

const dir = mkdtempSync(join(tmpdir(), "computer-provider-mount-"));
const DAEMON = join(dir, "computerd");
writeFileSync(DAEMON, "a stand-in for computerd\n");
after(() => rmSync(dir, { recursive: true, force: true }));

const declared = (provider) => provider.capabilities().mount ?? [];
/** A descriptor's mounts with no operator key set: its own and the synced folder it derives. */
const derived = (descriptor) => mountsOf(descriptor, () => false).mounts;

test("Docker: its descriptor's mounts are [\"bind\"], what its provider declares: no synced folder beside a bind", () => {
	assert.deepEqual([...DOCKER.mounts], ["bind"]);
	assert.deepEqual(derived(DOCKER), declared(fakeDocker().provider));
	assert.deepEqual(derived(DOCKER), declared(fakeDocker({ desktop: {} }).provider), "a desktop takes the same mount");
});

/** The Modal SDK's slice, never called: these build a provider only to read what it declares. */
const MODAL_SDK = {
	apps: { fromName: () => assert.fail("apps.fromName was called") },
	images: { fromRegistry: () => assert.fail("images.fromRegistry was called") },
	sandboxes: Object.fromEntries(["create", "fromId", "list"].map((name) => [name, () => assert.fail(`sandboxes.${name} was called`)])),
};

test("Modal: its descriptor's mounts are [\"archil\"], and a synced folder derived, what its provider declares", () => {
	const provider = new ModalProvider({ sdk: MODAL_SDK, app: "computers" });
	assert.deepEqual([...MODAL.mounts], ["archil"]);
	assert.deepEqual(derived(MODAL), ["archil", "sync"]);
	assert.deepEqual(derived(MODAL), declared(provider));
});

test("Daytona: its descriptor's mounts are [] (Archil's client hangs on its sandboxes), and a synced folder derived, what its provider declares", () => {
	const provider = new DaytonaProvider({ apiKey: "fake-test-key", apiUrl: "https://api.daytona.test/api", daemonPath: DAEMON, fetch: async () => assert.fail("no request") });
	assert.deepEqual([...DAYTONA.mounts], []);
	assert.deepEqual(derived(DAYTONA), ["sync"]);
	assert.deepEqual(derived(DAYTONA), declared(provider));
});

test("E2B: its descriptor's mounts are [\"archil\"], and a synced folder derived, what its provider declares", () => {
	const provider = new E2BProvider({ apiKey: "fake-test-key", Sandbox: Object.fromEntries(["create", "connect", "getInfo", "setTimeout", "kill", "list"].map((name) => [name, () => assert.fail(`Sandbox.${name} was called`)])), daemonPath: DAEMON });
	assert.deepEqual([...E2B.mounts], ["archil"]);
	assert.deepEqual(derived(E2B), ["archil", "sync"]);
	assert.deepEqual(derived(E2B), declared(provider));
});
