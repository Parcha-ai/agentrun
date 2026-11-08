// Each provider file's static MOUNT is what its provider declares: capabilities().mount, or none, on its fake. A caller
// reads MOUNT to tell which provider binds a local folder without building one, so the two never disagree.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DaytonaProvider, ModalProvider } from "../dist/index.js";
import * as daytona from "../dist/daytona.js";
import * as docker from "../dist/docker.js";
import * as e2b from "../dist/e2b.js";
import * as modal from "../dist/modal.js";
import { API, fakeDaytona, KEY } from "./fake-daytona.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeE2B, KEY as E2B_KEY } from "./fake-e2b.mjs";
import { DAEMON_IMAGE, fakeModal } from "./fake-modal.mjs";

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

test("Modal: MOUNT is [] until D6, what its provider declares", () => {
	const provider = new ModalProvider({ sdk: fakeModal().sdk, app: "computers", daemonImage: DAEMON_IMAGE });
	assert.deepEqual([...modal.MOUNT], []);
	assert.deepEqual([...modal.MOUNT], declared(provider));
});

test("Daytona: MOUNT is [\"archil\"], what its provider declares", () => {
	const fake = fakeDaytona();
	const provider = new DaytonaProvider({ apiKey: KEY, apiUrl: API, daemonPath: DAEMON, fetch: fake.fetch, webSocket: fake.webSocket });
	assert.deepEqual([...daytona.MOUNT], ["archil"]);
	assert.deepEqual([...daytona.MOUNT], declared(provider));
});

test("E2B: MOUNT is [] until D6, what its provider declares", () => {
	const provider = new e2b.E2BProvider({ apiKey: E2B_KEY, Sandbox: fakeE2B().Sandbox, daemonPath: DAEMON });
	assert.deepEqual([...e2b.MOUNT], []);
	assert.deepEqual([...e2b.MOUNT], declared(provider));
});
