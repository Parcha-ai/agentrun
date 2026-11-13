// The Orgo workspace a provider's computers live in when its settings name none (src/orgo-workspaces.ts): the key's
// account's one workspace from GET /workspaces; several refused in words naming them and pointing at Settings; none
// refused saying to make one; a deleted one never counted; an HTTP failure in words. And keyChoices, Settings' picker:
// each workspace's id and its name. Against a fake fetch (test/fake-orgo.mjs); nothing reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ORGO } from "../dist/descriptors/orgo.js";
import { API, fakeOrgoApi, fakeOrgoChannel, fakeWorkspace, KEY, WORKSPACE } from "./fake-orgo.mjs";
import { fakeOrgoDesktop } from "./fake-orgo-desktop.mjs";

const { create } = await import("../dist/orgo.js");
const { NO_WORKSPACE, orgoWorkspaces, soleWorkspace } = await import("../dist/orgo-workspaces.js");
const { orgoRest } = await import("../dist/orgo-channel.js");

const dir = mkdtempSync(join(tmpdir(), "computer-orgo-ws-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, "a stand-in for computerd\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 500, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5 };
const OTHER = "ws-1111-second";
const GONE = "ws-2222-deleted";

const restOf = (workspaces) => {
	const api = fakeOrgoApi({ workspaces });
	return { api, rest: orgoRest({ apiKey: KEY, apiUrl: API, fetch: api.fetch }) };
};
const keyless = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(KEY), `${what} holds the key`);

test("Orgo's descriptor no longer requires ORGO_WORKSPACE_ID: a person picks it, by name, or it is the key's one", () => {
	assert.deepEqual(
		ORGO.keys.map(({ name, required, picked }) => ({ name, required, picked: picked ?? false })),
		[
			{ name: "ORGO_API_KEY", required: true, picked: false },
			{ name: "ORGO_WORKSPACE_ID", required: false, picked: true },
		],
	);
});

test("one workspace: it is used; a deleted one is skipped; an inactive one is offered, said so", async () => {
	const { rest } = restOf([fakeWorkspace(WORKSPACE, "agentrun"), fakeWorkspace(GONE, "old", { deleted_at: "2026-10-01T00:00:00Z" })]);
	assert.deepEqual(await soleWorkspace(rest, { timeoutMs: 2_000 }), { ok: true, value: WORKSPACE });
	const listed = await orgoWorkspaces(restOf([fakeWorkspace(WORKSPACE, "agentrun", { status: "inactive" })]).rest, { timeoutMs: 2_000 });
	assert.deepEqual(listed, { ok: true, value: [{ id: WORKSPACE, name: "agentrun", status: "inactive" }] });
});

test("several workspaces: refused in words naming each and pointing at Settings → Computers", async () => {
	const { rest } = restOf([fakeWorkspace(WORKSPACE, "agentrun"), fakeWorkspace(OTHER, "second"), fakeWorkspace(GONE, "old", { deleted_at: "2026-10-01T00:00:00Z" })]);
	const refused = await soleWorkspace(rest, { timeoutMs: 2_000 });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "invalid");
	assert.match(refused.error.message, /has 2 workspaces \(agentrun, second\)/);
	assert.match(refused.error.message, /Settings → Computers \(ORGO_WORKSPACE_ID\)/);
	assert.doesNotMatch(refused.error.message, /old/, "a deleted workspace is never named");
});

test("no workspace (or only deleted ones): refused saying to make one at orgo.ai", async () => {
	for (const workspaces of [[], [fakeWorkspace(GONE, "old", { deleted_at: "2026-10-01T00:00:00Z" })]]) {
		const refused = await soleWorkspace(restOf(workspaces).rest, { timeoutMs: 2_000 });
		assert.deepEqual(refused, { ok: false, error: { code: "not_found", message: NO_WORKSPACE } });
	}
	assert.equal(NO_WORKSPACE, "this Orgo key's account has no workspace: make one at orgo.ai");
});

test("an HTTP failure of GET /workspaces is an error in words, its code kept, never the key", async () => {
	for (const [status, code] of [[401, "denied"], [500, "vendor"]]) {
		const failed = await soleWorkspace(restOf(status).rest, { timeoutMs: 2_000 });
		assert.equal(failed.ok, false);
		assert.equal(failed.error.code, code);
		assert.match(failed.error.message, new RegExp(`^Orgo's workspaces could not be read: Orgo's GET /workspaces answered ${status}`));
		keyless(failed, "the failure");
	}
	const { rest } = restOf([]);
	const wrong = await orgoWorkspaces({ ...rest, request: async () => ({ ok: true, value: { projects: [] } }) }, { timeoutMs: 2_000 });
	assert.deepEqual(wrong, { ok: false, error: { code: "vendor", vendor: "orgo", message: "Orgo's GET /workspaces answered no workspaces list" } });
});

test("a provider with no workspace option reads the key's one workspace once, and creates and lists there", async () => {
	const api = fakeOrgoApi();
	const provider = create({ apiKey: KEY, apiUrl: API, fetch: api.fetch, channel: fakeOrgoChannel(), timeouts: TIMEOUTS });
	assert.deepEqual(api.requests, [], "building it reads nothing");
	const listed = await provider.list({});
	assert.equal(listed.ok, true);
	await provider.list({});
	assert.deepEqual(api.routes(), ["GET /workspaces", `GET /workspaces/${WORKSPACE}`, `GET /workspaces/${WORKSPACE}`], "the workspace is read once, then kept");
	const tested = await provider.testConnection();
	assert.equal(tested.ok, true);
});

test("a provider with several workspaces and none named refuses its test, a list and a create in words, making nothing", async () => {
	const api = fakeOrgoApi({ workspaces: [fakeWorkspace(WORKSPACE, "agentrun"), fakeWorkspace(OTHER, "second")] });
	const provider = create({ apiKey: KEY, apiUrl: API, fetch: api.fetch, channel: fakeOrgoChannel(), timeouts: TIMEOUTS, daemonPath: DAEMON_PATH });
	const tested = await provider.testConnection();
	assert.equal(tested.ok, false);
	assert.match(tested.error.message, /2 workspaces \(agentrun, second\): pick the one its computers live in, in Settings → Computers/);
	const made = await provider.create({ image: "linux", lifetimeMs: 60_000, network: "none" }, { requestId: "claim-1" });
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "invalid");
	assert.ok(!api.routes().includes("POST /computers"), "nothing was made");
	// A workspace named in its settings is used as it is: GET /workspaces is never read.
	const named = fakeOrgoApi({ workspaces: [fakeWorkspace(WORKSPACE, "agentrun"), fakeWorkspace(OTHER, "second")] });
	await create({ apiKey: KEY, workspaceId: OTHER, apiUrl: API, fetch: named.fetch, channel: fakeOrgoChannel(), timeouts: TIMEOUTS }).list({});
	assert.deepEqual(named.routes(), [`GET /workspaces/${OTHER}`]);
});

test("a Windows desktop with no workspace option resolves it the same way: one used, several refused", async () => {
	const one = fakeOrgoDesktop();
	const used = create({ os: "windows", apiKey: KEY, apiUrl: API, fetch: one.fetch, timeouts: TIMEOUTS });
	assert.equal((await used.list({})).ok, true);
	assert.deepEqual(one.api.routes().slice(0, 2), ["GET /workspaces", `GET /workspaces/${WORKSPACE}`]);
	const several = fakeOrgoDesktop({ api: { workspaces: [fakeWorkspace(WORKSPACE, "agentrun"), fakeWorkspace(OTHER, "second")] } });
	const refused = await create({ os: "windows", apiKey: KEY, apiUrl: API, fetch: several.fetch, timeouts: TIMEOUTS }).list({});
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /2 workspaces/);
});

test("keyChoices: Settings' picker gets each workspace's id and its name; none is refused in words", async () => {
	const several = fakeOrgoApi({ workspaces: [fakeWorkspace(WORKSPACE, "agentrun"), fakeWorkspace(OTHER, "second", { status: "inactive" }), fakeWorkspace(GONE, "old", { deleted_at: "2026-10-01T00:00:00Z" })] });
	const provider = create({ apiKey: KEY, apiUrl: API, fetch: several.fetch, channel: fakeOrgoChannel(), timeouts: TIMEOUTS });
	assert.deepEqual(await provider.keyChoices("workspaceId"), { ok: true, value: [{ value: WORKSPACE, label: "agentrun" }, { value: OTHER, label: "second (inactive)" }] });
	assert.equal((await provider.keyChoices("apiKey")).error.code, "unsupported");
	const none = create({ apiKey: KEY, apiUrl: API, fetch: fakeOrgoApi({ workspaces: [] }).fetch, channel: fakeOrgoChannel(), timeouts: TIMEOUTS });
	assert.deepEqual(await none.keyChoices("workspaceId"), { ok: false, error: { code: "not_found", message: NO_WORKSPACE } });
	const failed = await create({ apiKey: KEY, apiUrl: API, fetch: fakeOrgoApi({ workspaces: 503 }).fetch, channel: fakeOrgoChannel(), timeouts: TIMEOUTS }).keyChoices("workspaceId");
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /Orgo's workspaces could not be read: .*503/);
});
