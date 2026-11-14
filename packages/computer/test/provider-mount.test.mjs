// Each provider file's static MOUNT is what its provider declares: capabilities().mount, or none, on its fake. A caller
// reads MOUNT to tell which provider binds a local folder without building one, so the two never disagree.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { ModalProvider } from "../dist/modal.js";
import * as daytona from "../dist/daytona.js";
import * as docker from "../dist/docker.js";
import * as e2b from "../dist/e2b.js";
import * as modal from "../dist/modal.js";
import { fakeDocker } from "./fake-docker.mjs";

const dir = mkdtempSync(join(tmpdir(), "computer-provider-mount-"));
const DAEMON = join(dir, "computerd");
writeFileSync(DAEMON, "a stand-in for computerd\n");
after(() => rmSync(dir, { recursive: true, force: true }));

const declared = (provider) => provider.capabilities().mount ?? [];

test("Docker: MOUNT is [\"bind\"], what its provider declares", () => {
	assert.deepEqual([...docker.MOUNT], ["bind"]);
	assert.deepEqual([...docker.MOUNT], declared(fakeDocker().provider));
	assert.deepEqual([...docker.MOUNT], declared(fakeDocker({ desktop: {} }).provider), "a desktop takes the same mount");
});

/** The Modal SDK's slice, never called: these build a provider only to read what it declares. */
const MODAL_SDK = {
	apps: { fromName: () => assert.fail("apps.fromName was called") },
	images: { fromRegistry: () => assert.fail("images.fromRegistry was called") },
	sandboxes: Object.fromEntries(["create", "fromId", "list"].map((name) => [name, () => assert.fail(`sandboxes.${name} was called`)])),
};

test("Modal: MOUNT is [\"archil\"], what its provider declares", () => {
	const provider = new ModalProvider({ sdk: MODAL_SDK, app: "computers" });
	assert.deepEqual([...modal.MOUNT], ["archil"]);
	assert.deepEqual([...modal.MOUNT], declared(provider));
});

test("Daytona: MOUNT is [], what its provider declares: Archil's client hangs on its sandboxes", () => {
	const provider = new DaytonaProvider({ apiKey: "fake-test-key", apiUrl: "https://api.daytona.test/api", daemonPath: DAEMON, fetch: async () => assert.fail("no request") });
	assert.deepEqual([...daytona.MOUNT], []);
	assert.deepEqual([...daytona.MOUNT], declared(provider));
});

test("E2B: MOUNT is [\"archil\"], what its provider declares", () => {
	const provider = new e2b.E2BProvider({ apiKey: "fake-test-key", Sandbox: Object.fromEntries(["create", "connect", "getInfo", "setTimeout", "kill", "list"].map((name) => [name, () => assert.fail(`Sandbox.${name} was called`)])), daemonPath: DAEMON });
	assert.deepEqual([...e2b.MOUNT], ["archil"]);
	assert.deepEqual([...e2b.MOUNT], declared(provider));
});
