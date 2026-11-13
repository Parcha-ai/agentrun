// testConnection: Settings' one account-level read per provider, which never creates a computer. ok with what it read;
// a key the vendor refused is unauthorized; the message never carries the key. Fakes only: no vendor, no Docker.
import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaProvider } from "../dist/daytona.js";
import { ModalProvider } from "../dist/modal.js";
import { E2BProvider } from "../dist/e2b.js";
import { fakeDaytona, KEY as DAYTONA_KEY, API } from "./fake-daytona.mjs";
import { container, fakeDocker } from "./fake-docker.mjs";
import { fakeE2B, KEY as E2B_KEY } from "./fake-e2b.mjs";
import { fakeModal } from "./fake-modal.mjs";
import { PhoneHarnessProvider } from "../dist/phone-harness.js";
import { fakePhoneHarness, KEY as PHONE_KEY } from "./fake-phone-harness.mjs";

const created = (fake) => fake.requests.filter((r) => r.method === "POST");

test("Docker: a list by the provider's label; ok with the count, and no container made", async () => {
	const { provider, calls } = fakeDocker();
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Docker answered: 0 computers of this provider/);
	assert.ok(calls().every((args) => !["run", "create", "volume"].includes(args[0])), JSON.stringify(calls()));
});

test("Daytona: a list by the provider's label; ok with the count; a refused key is unauthorized, and its words hold no key", async () => {
	const fake = fakeDaytona();
	const provider = new DaytonaProvider({ apiKey: DAYTONA_KEY, apiUrl: API, daemonPath: "/nonexistent/computerd", fetch: fake.fetch, webSocket: fake.webSocket });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Daytona answered: 0 computers of this provider/);
	assert.deepEqual(created(fake), [], "nothing made");
	fake.knobs.fail = [{ method: "GET", path: /^\/api\/sandbox$/, status: 401, times: 1 }];
	const refused = await provider.testConnection();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unauthorized");
	assert.ok(!refused.error.message.includes(DAYTONA_KEY), "the key is never in the words");
});

test("E2B: a list by the provider's metadata; ok with the count; a refused key is unauthorized", async () => {
	let refuse = false;
	const fake = fakeE2B({
		onStep: (step) => {
			if (refuse && step === "Sandbox.list") throw Object.assign(new Error("Unauthorized, please check your credentials."), { name: "AuthenticationError" });
		},
	});
	const provider = new E2BProvider({ apiKey: E2B_KEY, Sandbox: fake.Sandbox });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /E2B answered: 0 computers of this provider/);
	assert.ok(!fake.calls.some(([name]) => name === "Sandbox.create"), "nothing made");
	refuse = true;
	const refused = await provider.testConnection();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "unauthorized");
	assert.ok(!refused.error.message.includes(E2B_KEY));
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
	const fake = fakeDaytona({ listBack: () => ({ networkBlockAll: undefined }) });
	for (const name of NAMES) fake.seed({ name, labels: { "agentrun.computer": "1" } });
	fake.seed({ name: "someone-else", labels: { "agentrun.computer": "1" } });
	const provider = new DaytonaProvider({ apiKey: DAYTONA_KEY, apiUrl: API, daemonPath: "/nonexistent/computerd", fetch: fake.fetch, webSocket: fake.webSocket });
	// A read of one sandbox that fails would fail the key: none is made.
	fake.knobs.fail = [{ method: "GET", path: /^\/api\/sandbox\/[^/]+$/, status: 500, times: 10 }];
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /^Daytona answered: 3 computers of this provider$/);
	assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path}`), ["GET /api/sandbox"], "one read: no sandbox read back");
});

test("E2B: on an account with several computers, one listing page counts them, and getInfo reads none", async () => {
	const fake = fakeE2B();
	for (const name of NAMES) fake.add({ metadata: { "agentrun.computer": "1", "agentrun.computer.name": name } });
	fake.add({ metadata: { "agentrun.computer": "1", "agentrun.computer.name": "someone-else" } });
	const provider = new E2BProvider({ apiKey: E2B_KEY, Sandbox: fake.Sandbox });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /^E2B answered: 3 computers of this provider$/);
	assert.deepEqual(fake.names(), ["Sandbox.list", "paginator.nextItems"], "one page: getInfo reads no sandbox");
});

test("Modal: the provider's app read without creating it; ok whether it exists or not yet; an unauthenticated token is unauthorized", async () => {
	const fake = fakeModal();
	const provider = new ModalProvider({ sdk: fake.sdk, app: "computers", daemonImage: `ghcr.io/example/computerd@sha256:${"a".repeat(64)}` });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true, JSON.stringify(tested));
	assert.match(tested.value.detail, /Modal answered: the app computers is there/);
	assert.deepEqual(fake.calls.find(([name]) => name === "apps.fromName").slice(1), ["computers", { createIfMissing: false }], "a read, never a create");
	assert.ok(!fake.calls.some(([name]) => name === "sandboxes.create"));
	fake.sdk.apps.fromName = async () => {
		throw Object.assign(new Error("App 'computers' not found"), { name: "NotFoundError" });
	};
	const absent = await provider.testConnection();
	assert.equal(absent.ok, true, JSON.stringify(absent));
	assert.match(absent.value.detail, /Modal answered: no app computers yet; the first computer makes it/);
	fake.sdk.apps.fromName = async () => {
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
