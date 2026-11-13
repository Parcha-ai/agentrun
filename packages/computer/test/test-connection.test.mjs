// testConnection: Settings' one account-level read per provider, which never creates a computer. ok with what it read;
// a key the vendor refused is unauthorized; the message never carries the key. Fakes only: no vendor, no Docker.
import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { ModalProvider } from "../dist/modal.js";
import { container, fakeDocker } from "./fake-docker.mjs";
import { PhoneHarnessProvider } from "../dist/phone-harness.js";
import { fakePhoneHarness, KEY as PHONE_KEY } from "./fake-phone-harness.mjs";

test("Docker: a list by the provider's label; ok with the count, and no container made", async () => {
	const { provider, calls } = fakeDocker();
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Docker answered: 0 computers of this provider/);
	assert.ok(calls().every((args) => !["run", "create", "volume"].includes(args[0])), JSON.stringify(calls()));
});

const DAYTONA_KEY = "fake-test-key-daytona";
const DAYTONA_API = "https://api.daytona.test/api";

/** Daytona's listing as one canned page (or a status), every request recorded: no sandbox is made or read. */
function daytonaListing(answer) {
	const requests = [];
	const fetch = async (url, init) => {
		const at = new URL(url);
		requests.push({ method: init.method, path: at.pathname });
		const { status = 200, body } = answer(at, init);
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	};
	return { requests, provider: new DaytonaProvider({ apiKey: DAYTONA_KEY, apiUrl: DAYTONA_API, daemonPath: "/nonexistent/computerd", fetch }) };
}

test("Daytona: a list by the provider's label; ok with the count; a refused key is unauthorized, and its words hold no key", async () => {
	let refuse = false;
	const { requests, provider } = daytonaListing(() => (refuse ? { status: 401, body: { statusCode: 401, message: "Invalid credentials" } } : { body: { items: [] } }));
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Daytona answered: 0 computers of this provider/);
	assert.deepEqual(requests.filter((r) => r.method !== "GET"), [], "nothing made");
	refuse = true;
	const refused = await provider.testConnection();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unauthorized");
	assert.ok(!refused.error.message.includes(DAYTONA_KEY), "the key is never in the words");
});

/** Three computers of this provider's making by name, and one other: a key test counts the three from one listing. */
const NAMES = ["computer-00000000000a", "computer-00000000000b", "computer-00000000000c"];

test("Docker: on a host with several computers, one docker ps counts them, and no container is inspected", async () => {
	const { provider, calls } = fakeDocker({ containers: [...NAMES.map((name) => container({ name })), container({ name: "postgres" })] });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /^Docker answered: 3 computers of this provider$/);
	assert.deepEqual(calls().map((args) => args[0]), ["ps"], "one read: no inspect of each computer");
});

test("Daytona: on an account with several computers, one listing page counts them, and no sandbox is read back", async () => {
	const labels = (name) => ({ "agentrun.computer": "1", "agentrun.computer.name": name });
	const items = [...NAMES.map((name, i) => ({ id: `sb-${i}`, name, state: "started", labels: labels(name) })), { id: "sb-x", name: "someone-else", state: "started", labels: labels("someone-else") }];
	// A read of one sandbox would fail the key: none is made.
	const { requests, provider } = daytonaListing((at) => (at.pathname === "/api/sandbox" ? { body: { items } } : { status: 500, body: {} }));
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /^Daytona answered: 3 computers of this provider$/);
	assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ["GET /api/sandbox"], "one read: no sandbox read back");
});

test("Modal: the provider's app read without creating it; ok whether it exists or not yet; an unauthenticated token is unauthorized", async () => {
	// The SDK's slice as a recorder: apps.fromName answers, and anything else fails the test.
	const calls = [];
	const never = (name) => () => assert.fail(`${name} was called`);
	const sdk = {
		apps: { fromName: async (...args) => (calls.push(["apps.fromName", ...args]), { appId: "ap-computers" }) },
		images: { fromRegistry: never("images.fromRegistry") },
		sandboxes: { create: never("sandboxes.create"), fromId: never("sandboxes.fromId"), list: never("sandboxes.list") },
	};
	const provider = new ModalProvider({ sdk, app: "computers" });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Modal answered: the app computers is there/);
	assert.deepEqual(calls, [["apps.fromName", "computers", { createIfMissing: false }]], "a read, never a create");
	sdk.apps.fromName = async () => {
		throw Object.assign(new Error("App 'computers' not found"), { name: "NotFoundError" });
	};
	const absent = await provider.testConnection();
	assert.equal(absent.ok, true, JSON.stringify(absent));
	assert.match(absent.value.detail, /Modal answered: no app computers yet; the first computer makes it/);
	sdk.apps.fromName = async () => {
		throw Object.assign(new Error("Token missing or invalid"), { code: 16 });
	};
	const refused = await provider.testConnection();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unauthorized");
});

test("phone-harness: one GET /sessions, which rents nothing; ok with its own phones' count; a refused key is unauthorized, and a phone harness not reached unreachable", async () => {
	const fake = fakePhoneHarness();
	// A session on the account that this provider did not make is not counted.
	fake.sessions.set("sess_other", { id: "sess_other", state: "ready", platform: "android", kind: "emulator", expires_at: Date.now() / 1000 + 600 });
	const provider = new PhoneHarnessProvider({ apiKey: PHONE_KEY, fetch: fake.fetch, adb: fake.adb });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /^Phone harness answered: 0 computers of this provider$/);
	assert.deepEqual(fake.requests().map((r) => `${r.method} ${r.path}`), ["GET /sessions"], "one read, and nothing rented");
	assert.deepEqual(fake.adbCalls(), [], "no phone is reached");

	const wrongKey = new PhoneHarnessProvider({ apiKey: "not-a-secret", fetch: fake.fetch, adb: fake.adb });
	const refused = await wrongKey.testConnection();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unauthorized");
	assert.ok(!refused.error.message.includes("not-a-secret"), "the key is never in the words");

	const away = new PhoneHarnessProvider({
		apiKey: PHONE_KEY,
		fetch: async () => {
			throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.phone-harness.com");
		},
		adb: fake.adb,
	});
	const unreached = await away.testConnection();
	assert.equal(unreached.ok, false);
	assert.equal(unreached.error.code, "unreachable");
	assert.match(unreached.error.message, /^GET \/sessions: the phone harness could not be reached: fetch failed/);
});
