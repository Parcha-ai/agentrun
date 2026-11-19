// Fly, Cloudflare, Modal and Daytona's conformance modules take a kind from COMPUTER_<V>_KIND, as e2b's does, in
// createProvider() only: dial-conformance.mjs runs casesFor(provider.capabilities().kind), so a live kit needs the desktop
// suite to be reachable. Unset is the vendor's own default (linux). A kind a vendor refuses is refused by its create() in
// its own words. Every key here is an obvious fake; nothing reaches a network.
import assert from "node:assert/strict";
import test from "node:test";
import { AttachHub, MemoryMachineTokens } from "../dist/index.js";

const fly = await import("../dist/conformance/fly.js");
const cloudflare = await import("../dist/conformance/cloudflare.js");
const modal = await import("../dist/conformance/modal.js");
const daytona = await import("../dist/conformance/daytona.js");

const dial = () => ({ url: "https://agentrun.example.com", tokens: new MemoryMachineTokens(), hub: new AttachHub() });
const FLY = { COMPUTER_FLY_API_TOKEN: "fake-test-key-fly", COMPUTER_FLY_APP: "agentrun-conformance" };
const CLOUDFLARE = { COMPUTER_CLOUDFLARE_RELAY_URL: "https://agentrun-relay.example.workers.dev", COMPUTER_CLOUDFLARE_RELAY_TOKEN: "fake-test-key-relay" };
const MODAL = { AGENTRUN_COMPUTER_LIVE_MODAL: "1", COMPUTER_MODAL_TOKEN_ID: "fake-test-key-id", COMPUTER_MODAL_TOKEN_SECRET: "fake-test-key-secret", COMPUTER_MODAL_APP: "computers" };
const DAYTONA = { COMPUTER_DAYTONA_API_KEY: "fake-test-key-daytona" };
const stub = () => async () => ({});
/** A ModalClient whose sdk has the methods the provider checks for and calls none. */
function ModalClient() {
	return { apps: { fromName: stub() }, images: { fromRegistry: stub() }, sandboxes: { create: stub(), fromId: stub(), list: stub() } };
}

test("each module names COMPUTER_<V>_KIND in its env table", () => {
	assert.equal(fly.ENV.kind, "COMPUTER_FLY_KIND");
	assert.equal(cloudflare.ENV.kind, "COMPUTER_CLOUDFLARE_KIND");
	assert.equal(modal.ENV.kind, "COMPUTER_MODAL_KIND");
	assert.equal(daytona.ENV.kind, "COMPUTER_DAYTONA_KIND");
});

test("Fly: COMPUTER_FLY_KIND=desktop gives a desktop provider; unset stays linux", () => {
	assert.equal(fly.createProvider({ env: { ...FLY, COMPUTER_FLY_KIND: "desktop" }, dial: dial() }).capabilities().kind, "desktop");
	assert.equal(fly.createProvider({ env: FLY, dial: dial() }).capabilities().kind, "linux");
	assert.equal(fly.createProvider({ env: { ...FLY, COMPUTER_FLY_KIND: "" }, dial: dial() }).capabilities().kind, "linux", "empty is unset");
	assert.equal("kind" in fly.settingsFromEnv({ ...FLY, COMPUTER_FLY_KIND: "desktop" }), false, "settingsFromEnv, the sweep's and the drift builder's, reads no kind");
	assert.throws(() => fly.createProvider({ env: { ...FLY, COMPUTER_FLY_KIND: "mac" }, dial: dial() }), /kind is desktop or linux, not mac/);
});

test("Cloudflare: COMPUTER_CLOUDFLARE_KIND=desktop gives a desktop provider; unset stays linux", () => {
	assert.equal(cloudflare.createProvider({ env: { ...CLOUDFLARE, COMPUTER_CLOUDFLARE_KIND: "desktop" }, dial: dial() }).capabilities().kind, "desktop");
	assert.equal(cloudflare.createProvider({ env: CLOUDFLARE, dial: dial() }).capabilities().kind, "linux");
	assert.equal("kind" in cloudflare.settingsFromEnv({ ...CLOUDFLARE, COMPUTER_CLOUDFLARE_KIND: "desktop" }), false);
	assert.throws(() => cloudflare.createProvider({ env: { ...CLOUDFLARE, COMPUTER_CLOUDFLARE_KIND: "mac" }, dial: dial() }), /kind is desktop or linux, not mac/);
});

test("Modal: COMPUTER_MODAL_KIND=desktop on dial gives a desktop provider; on exec the provider refuses in its words; unset stays linux", async () => {
	const on = { ...MODAL, COMPUTER_MODAL_CONNECT: "dial" };
	assert.equal((await modal.createProvider({ env: { ...on, COMPUTER_MODAL_KIND: "desktop" }, ModalClient, dial: dial() })).capabilities().kind, "desktop");
	assert.equal((await modal.createProvider({ env: on, ModalClient, dial: dial() })).capabilities().kind, "linux");
	assert.equal((await modal.createProvider({ env: MODAL, ModalClient })).capabilities().kind, "linux");
	assert.equal("kind" in modal.settingsFromEnv({ ...on, COMPUTER_MODAL_KIND: "desktop" }), false);
	await assert.rejects(modal.createProvider({ env: { ...MODAL, COMPUTER_MODAL_KIND: "desktop" }, ModalClient }), /a Modal desktop is made on connect "dial" alone/);
});

test("Daytona: COMPUTER_DAYTONA_KIND=desktop on dial gives a desktop provider; on exec the provider refuses in its words; unset stays linux", () => {
	const on = { ...DAYTONA, COMPUTER_DAYTONA_CONNECT: "dial" };
	assert.equal(daytona.createProvider({ env: { ...on, COMPUTER_DAYTONA_KIND: "desktop" }, dial: dial() }).capabilities().kind, "desktop");
	assert.equal(daytona.createProvider({ env: on, dial: dial() }).capabilities().kind, "linux");
	assert.equal(daytona.createProvider({ env: DAYTONA }).capabilities().kind, "linux");
	assert.equal("kind" in daytona.settingsFromEnv({ ...on, COMPUTER_DAYTONA_KIND: "desktop" }), false);
	assert.throws(() => daytona.createProvider({ env: { ...DAYTONA, COMPUTER_DAYTONA_KIND: "desktop" } }), /a Daytona desktop is made on connect "dial" alone/);
});
