// Orgo's conformance module (src/conformance/orgo.ts) and its registry line: the live switch first, the COMPUTER_ORGO_*
// settings (settingsFromEnv) listed in its env names, a run's computers capped at Orgo's shortest end (1 h), the base
// image unless a template is named, and the drifted twin. The registry offers Orgo for the desktop kind. No call.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDERS, providerIds } from "../dist/index.js";
import { fakeOrgoApi, KEY, WORKSPACE } from "./fake-orgo.mjs";

const conformance = await import("../dist/conformance/orgo.js");
const { CONFORMANCE_MAX_LIFETIME_MS, conformanceImage, createDriftedProvider, createProvider, ENV, settingsFromEnv } = conformance;
const dir = mkdtempSync(join(tmpdir(), "computer-orgo-module-"));
const DRIFT = join(dir, "computerd-drift");
writeFileSync(DRIFT, "a daemon of another version\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));
const ENV_OK = { AGENTRUN_COMPUTER_LIVE_ORGO: "1", COMPUTER_ORGO_API_KEY: KEY, COMPUTER_ORGO_WORKSPACE: WORKSPACE };

test("the Orgo module's env names: the live switch, the key, the workspace, the API URL, the run's template and the desktop's os, each COMPUTER_ORGO_* but the switch", () => {
	assert.deepEqual(ENV, {
		live: "AGENTRUN_COMPUTER_LIVE_ORGO",
		template: "COMPUTER_ORGO_TEMPLATE",
		key: "COMPUTER_ORGO_API_KEY",
		workspace: "COMPUTER_ORGO_WORKSPACE",
		apiUrl: "COMPUTER_ORGO_API_URL",
		os: "COMPUTER_ORGO_OS",
	});
	assert.deepEqual(settingsFromEnv({ COMPUTER_ORGO_API_KEY: KEY, COMPUTER_ORGO_WORKSPACE: WORKSPACE }), { apiKey: KEY, workspaceId: WORKSPACE });
	assert.deepEqual(settingsFromEnv({ COMPUTER_ORGO_API_KEY: KEY, COMPUTER_ORGO_WORKSPACE: WORKSPACE, COMPUTER_ORGO_API_URL: "https://orgo.example/api" }).apiUrl, "https://orgo.example/api");
	assert.throws(() => settingsFromEnv({ ORGO_API_KEY: KEY, COMPUTER_ORGO_WORKSPACE: WORKSPACE }), (error) => /COMPUTER_ORGO_API_KEY/.test(error.message) && !error.message.includes(KEY));
});

test("the Orgo module makes nothing without its live switch, checked before any other setting; then a provider capped at 1 h", async () => {
	const api = fakeOrgoApi();
	await assert.rejects(createProvider({ env: { COMPUTER_ORGO_API_KEY: KEY, COMPUTER_ORGO_WORKSPACE: WORKSPACE }, fetch: api.fetch }), /AGENTRUN_COMPUTER_LIVE_ORGO=1/);
	await assert.rejects(createProvider({ env: { AGENTRUN_COMPUTER_LIVE_ORGO: "1" }, fetch: api.fetch }), /COMPUTER_ORGO_API_KEY/);
	const provider = await createProvider({ env: ENV_OK, fetch: api.fetch });
	assert.equal(provider.id, "orgo");
	assert.equal(CONFORMANCE_MAX_LIFETIME_MS, 60 * 60_000);
	assert.equal(provider.capabilities().maxLifetimeMs, CONFORMANCE_MAX_LIFETIME_MS);
	const drifted = await createDriftedProvider({ env: ENV_OK, fetch: api.fetch, buildDaemon: async () => DRIFT });
	assert.equal(drifted.id, "orgo");
	assert.equal(conformanceImage({ env: {} }), "linux");
	assert.equal(conformanceImage({ env: { COMPUTER_ORGO_TEMPLATE: "default/agentrun-desktop@1.0.0" } }), "default/agentrun-desktop@1.0.0");
	assert.deepEqual(api.requests, [], "building providers calls nothing");
});

test("the registry holds orgo, and its Settings entry: the desktop kind, the ORGO_API_KEY key, no mount, metered, its module's capabilities", async () => {
	assert.ok(providerIds.includes("orgo"));
	const entry = PROVIDERS.find((one) => one.id === "orgo");
	assert.deepEqual(entry.kinds, ["desktop"], "a desktop only: an agent that wants a sandbox gets a cheaper one");
	assert.deepEqual(entry.keys, [{ name: "ORGO_API_KEY", required: true }]);
	assert.deepEqual(entry.mounts, []);
	assert.equal(entry.metered, true);
	const orgo = await import("../dist/orgo.js");
	assert.deepEqual(entry.capabilities, orgo.CAPABILITIES);
});
