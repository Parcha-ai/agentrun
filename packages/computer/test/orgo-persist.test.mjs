// An agent's own Orgo computer, by the persistence contract (spec.owner, capabilities().persistence, release "detach",
// attach under a claim): made with an owner and no lifetime, it has no deadline and no Orgo end, and its name carries
// only its owner's hash. Its labels (the owner's, the claim's run and epoch) and when it was detached are kept in the
// provider's ledger, so list reads them with nothing run inside a computer that is suspended or stopped. Linux detaches
// by suspend (memory and init kept), Windows by stop (its disk kept), and a Mac, which Orgo never stops, takes no owner.
// Orgo offers Linux desktops alone: Windows and macOS are parked (in no configuration), their code kept, and these tests
// keep it honest beside the Linux ones. Against the fakes; nothing reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownerFilter, sweep } from "../dist/index.js";
import { API, fakeOrgoApi, fakeOrgoChannel, KEY, WORKSPACE } from "./fake-orgo.mjs";
import { fakeOrgoDesktop, WINDOWS_LABELS } from "./fake-orgo-desktop.mjs";

const { create } = await import("../dist/orgo.js");

const HOUR = 3_600_000;
const OWNER = { agent: "agent-7" };
const OWNER_VALUE = "agent:agent-7";
const LABELS = { "agentrun.run": "run-1", "agentrun.epoch": "1", team: "a" };
const DESKTOP_TIMEOUTS = { requestMs: 2_000, createMs: 2_000, execMs: 2_000, listMs: 2_000, goneMs: 500, pollMs: 5 };
const LINUX_TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 500, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5 };
const dir = mkdtempSync(join(tmpdir(), "computer-orgo-persist-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, "a stand-in for computerd, linux/amd64\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A ledger as serve's store backs it: async, a fresh copy on every read, and swap a compare-and-set on the row's JSON.
 * gate(was, entry) may return a promise a swap waits for before it compares: a test makes one attach's swap land last.
 */
function storeLedger({ gate } = {}) {
	const rows = new Map();
	return {
		rows,
		put: async (entry) => void rows.set(entry.id, structuredClone(entry)),
		get: async (id) => structuredClone(rows.get(id)),
		list: async () => [...rows.values()].map((entry) => structuredClone(entry)),
		remove: async (id) => void rows.delete(id),
		swap: async (was, entry) => {
			await gate?.(was, entry);
			if (!rows.has(entry.id) || JSON.stringify(rows.get(entry.id)) !== JSON.stringify(was)) return false;
			rows.set(entry.id, structuredClone(entry));
			return true;
		},
	};
}
function desktop(os = "windows", { fake = fakeOrgoDesktop({ os }), ledger = storeLedger() } = {}) {
	const provider = create({ os, apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: fake.fetch, timeouts: DESKTOP_TIMEOUTS, ledger });
	return { fake, provider, ledger };
}
function linux({ api = fakeOrgoApi(), channel = fakeOrgoChannel(), ledger = storeLedger() } = {}) {
	const provider = create({ apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: api.fetch, channel, daemonPath: DAEMON_PATH, timeouts: LINUX_TIMEOUTS, ledger });
	return { api, channel, provider, ledger };
}
const calls = (api, verb) => api.requests.filter(({ method, path }) => method === "POST" && path.endsWith(`/${verb}`));
const bashCalls = (api) => api.requests.filter(({ path }) => path.endsWith("/bash")).length;
const windowsSpec = (extra = {}) => ({ image: "windows", network: "open", labels: LABELS, owner: OWNER, ...extra });

test("Orgo's persistence: Linux resumes where it was (suspend), Windows comes back from its disk (stop), a Mac declares none; release declares delete alone", () => {
	assert.deepEqual(linux().provider.capabilities().persistence, { keepsState: true, resume: true });
	assert.deepEqual(desktop("windows").provider.capabilities().persistence, { keepsState: true, resume: false });
	assert.equal(desktop("macos").provider.capabilities().persistence, undefined);
	for (const provider of [linux().provider, desktop("windows").provider, desktop("macos").provider]) assert.deepEqual(provider.capabilities().release, ["delete"]);
});

test("Orgo's check(): an agent's spec takes no lifetime; owner is { agent }; the owner and idle-TTL labels are the provider's own; a Mac refuses an owner", () => {
	const { provider } = desktop("windows");
	assert.deepEqual(provider.check(windowsSpec()), []);
	assert.ok(provider.check(windowsSpec({ lifetimeMs: 30 * 60_000 })).some(({ field }) => field === "lifetimeMs"), "an agent's computer has no run deadline");
	assert.ok(provider.check({ image: "windows", network: "open" }).some(({ field }) => field === "lifetimeMs"), "a run's computer still needs one");
	for (const owner of ["agent-7", { agent: "" }]) {
		assert.ok(provider.check(windowsSpec({ owner })).some(({ field }) => field === "owner"), JSON.stringify(owner));
	}
	for (const label of ["agentrun.owner", "agentrun.idle-ttl-ms"]) {
		assert.ok(provider.check(windowsSpec({ labels: { ...LABELS, [label]: "x" } })).some(({ field, message }) => field === "labels" && /provider's own/.test(message)), label);
	}
	const mac = desktop("macos").provider.check({ image: "macos", network: "open", owner: OWNER });
	assert.ok(mac.some(({ field, message }) => field === "owner" && /no persistence/.test(message)), JSON.stringify(mac));
	assert.deepEqual(linux().provider.check({ image: "linux", network: "none", owner: OWNER }), []);
});

test("Orgo Windows: an agent's computer has no deadline or Orgo end; its labels are the ledger's; detach stops it and says when; attach under a claim starts it and takes the claim's run and epoch; a lower epoch is fenced", async () => {
	const { fake, provider, ledger } = desktop("windows");
	const created = await provider.create(windowsSpec());
	assert.equal(created.ok, true, JSON.stringify(created));
	const ref = created.value;
	assert.match(ref.name, /^computer-[0-9a-f]{12}-o[a-z2-7]{16}$/, "the owner's hash, no run, no epoch, no deadline");
	const record = fake.api.computers.get(ref.id);
	assert.equal(record.asked.ends_in_hours, undefined, "no Orgo end");
	const file = JSON.parse(fake.boxOf(ref.id).files.get(WINDOWS_LABELS).toString("utf8"));
	assert.deepEqual([file.labels["agentrun.owner"], file.deadline, file.maxDeadline], [OWNER_VALUE, "none", "none"]);
	assert.deepEqual(ledger.rows.get(ref.id), { id: ref.id, labels: { ...LABELS, "agentrun.owner": OWNER_VALUE } });

	const mine = (await provider.list({ "agentrun.owner": OWNER_VALUE })).value;
	assert.deepEqual(mine.map((info) => [info.ref.id, info.deadline, info.state, info.labels, info.owned, info.owner]), [[ref.id, undefined, "running", { ...LABELS, "agentrun.owner": OWNER_VALUE }, true, OWNER]]);
	assert.deepEqual((await provider.list({ "agentrun.owner": "agent:someone-else" })).value, []);
	assert.deepEqual((await provider.list({ team: "b" })).value, []);
	assert.equal((await provider.list({ "agentrun.run": "run-1", "agentrun.epoch": "1" })).value.length, 1, "the run that holds it finds it by its claim's labels");
	assert.equal((await provider.extend(ref, HOUR)).error.code, "refused", "no deadline to move");

	assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
	assert.equal(record.status, "frozen", "Orgo's stop: its disk archived");
	assert.equal(calls(fake.api, "stop").length, 1);
	const reads = bashCalls(fake.api);
	const [detached] = (await provider.list({ team: "a" })).value;
	assert.equal(bashCalls(fake.api), reads, "a stopped computer's labels come from the ledger, never from inside");
	assert.deepEqual([detached.state, detached.labels["agentrun.owner"]], ["stopped", OWNER_VALUE]);
	assert.ok(detached.detachedAt instanceof Date && Date.now() - detached.detachedAt.getTime() < 60_000, String(detached.detachedAt));
	assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined }, "a second detach of a stopped one is done");
	assert.equal(ledger.rows.get(ref.id).detachedAt, detached.detachedAt.toISOString(), "and keeps when it was first detached");
	assert.equal(calls(fake.api, "stop").length, 1);
	assert.equal((await provider.connect(ref)).error.code, "refused", "a connect does not start it: attach does");

	const attached = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 3 } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(calls(fake.api, "start").length, 1);
	assert.equal(record.status, "running");
	assert.equal(attached.value.spec.deadline, undefined);
	assert.deepEqual(attached.value.spec.owner, OWNER, "its owner, read back");
	const [back] = (await provider.list({ "agentrun.owner": OWNER_VALUE })).value;
	assert.deepEqual([back.state, back.labels["agentrun.run"], back.labels["agentrun.epoch"], back.labels.team, back.detachedAt], ["running", "run-2", "3", "a", undefined]);
	const written = JSON.parse(fake.boxOf(ref.id).files.get(WINDOWS_LABELS).toString("utf8"));
	assert.deepEqual([written.labels["agentrun.run"], written.labels["agentrun.epoch"]], ["run-2", "3"], "the labels file carries the claim too");

	const fenced = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } });
	assert.equal(fenced.ok, false);
	assert.equal(fenced.error.code, "refused");
	assert.match(fenced.error.message, /fenced/);
	assert.equal(ledger.rows.get(ref.id).labels["agentrun.epoch"], "3", "a fenced claim changes nothing");
	assert.equal((await provider.attach({ id: ref.id }, { claim: { run: "run-9", epoch: 1 } })).ok, true, "another run's claim takes it, at any epoch");

	assert.equal((await provider.connect(ref)).ok, true);
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined }, "and it is deleted when its agent is done with it");
	assert.equal(ledger.rows.has(ref.id), false, "its ledger entry with it");
});

test("Orgo: an agent's computer with no ledger entry has unknown labels: listed owned with no owner to an unfiltered list alone, kept by the janitor, never attached or detached, and deleted on request", async () => {
	const fake = fakeOrgoDesktop({ os: "windows" });
	const first = desktop("windows", { fake });
	const ref = (await first.provider.create(windowsSpec())).value;
	const { provider, ledger } = desktop("windows", { fake });
	assert.deepEqual((await provider.list({})).value.map((info) => [info.ref.id, info.labels, info.owned, info.owner]), [[ref.id, {}, true, undefined]]);
	assert.deepEqual((await provider.list({ "agentrun.owner": OWNER_VALUE })).value, [], "no label is proved without the entry, its owner's neither");
	const swept = await sweep(provider, { now: new Date(Date.now() + 10_000 * HOUR), ownerGone: () => true });
	assert.deepEqual(swept, { ok: true, value: { deleted: [], kept: 1 } }, "an owner the janitor cannot read keeps the computer");

	const reads = bashCalls(fake.api);
	for (const [what, result] of [
		["attach", await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } })],
		["detach", await provider.release(ref, "detach")],
	]) {
		assert.equal(result.error?.code, "refused", what);
		assert.match(result.error.message, /no entry in the provider's ledger.*release it with delete/, what);
	}
	assert.equal(bashCalls(fake.api), reads, "nothing ran in it");
	assert.deepEqual([calls(fake.api, "stop").length, fake.api.computers.get(ref.id).status, ledger.rows.size], [0, "running", 0], "nothing changed");
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
});

test("Orgo: the janitor deletes an agent's computer only when its owner is gone or it has idled past its TTL, never by a deadline", async () => {
	const { provider } = desktop("windows");
	const ref = (await provider.create(windowsSpec({ owner: { agent: "agent-7", idleTtlMs: HOUR } }))).value;
	const far = new Date(Date.now() + 1_000 * HOUR);
	assert.deepEqual(await sweep(provider, { now: far, ownerGone: () => false }), { ok: true, value: { deleted: [], kept: 1 } }, "running, held: kept whatever the time");
	await provider.release(ref, "detach");
	assert.deepEqual(await sweep(provider, { ownerGone: () => false }), { ok: true, value: { deleted: [], kept: 1 } }, "detached, within its TTL");
	assert.deepEqual(await sweep(provider, { now: new Date(Date.now() + 2 * HOUR), ownerGone: () => false }), { ok: true, value: { deleted: [ref.name], kept: 0 } }, "detached past its TTL");

	const other = desktop("windows");
	const held = (await other.provider.create(windowsSpec())).value;
	assert.deepEqual(await sweep(other.provider, { now: far, ownerGone: ({ agent }) => agent === "agent-7" }), { ok: true, value: { deleted: [held.name], kept: 0 } }, "its owner gone");
});

test("Orgo: in one workspace, the Linux provider lists no Windows desktop (Orgo's listing names each one's os), so its janitor never sweeps the other provider's agent's computer", async () => {
	const fake = fakeOrgoDesktop({ os: "windows" });
	const ledger = storeLedger();
	const windows = desktop("windows", { fake, ledger }).provider;
	const ref = (await windows.create(windowsSpec())).value;
	const lin = create({ apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: fake.fetch, channel: fakeOrgoChannel(), daemonPath: DAEMON_PATH, timeouts: LINUX_TIMEOUTS, ledger });
	assert.deepEqual((await lin.list({})).value, []);
	assert.deepEqual(await sweep(lin, { ownerGone: () => true }), { ok: true, value: { deleted: [], kept: 0 } });
	assert.deepEqual(await sweep(windows, { ownerGone: () => true }), { ok: true, value: { deleted: [ref.name], kept: 0 } }, "its own provider's janitor does");
});

test("Orgo: a run's computer is never detached, never taken under a claim, and one that is not running is never woken by attach", async () => {
	const { fake, provider } = desktop("windows");
	const created = (await provider.create({ image: "windows", lifetimeMs: 30 * 60_000, network: "open", labels: LABELS })).value;
	const detached = await provider.release(created, "detach");
	assert.equal(detached.ok, false);
	assert.match(detached.error.message, /a run's computer, not an agent's own/);
	const claimed = await provider.attach({ id: created.id }, { claim: { run: "run-2", epoch: 2 } });
	assert.equal(claimed.error.code, "refused");
	assert.match(claimed.error.message, /a run's computer/);
	assert.equal((await provider.list({ "agentrun.owner": OWNER_VALUE })).value.length, 0, "an owner's listing never finds a run's computer");
	fake.api.computers.get(created.id).status = "frozen";
	assert.equal((await provider.attach({ id: created.id })).error.code, "refused");
	assert.equal(calls(fake.api, "start").length, 0);
});

test("Orgo macOS: no agent's computer, since Orgo stops no Mac: create with an owner is refused before Orgo is called", async () => {
	const { fake, provider } = desktop("macos");
	const created = await provider.create({ image: "macos", network: "open", owner: OWNER });
	assert.equal(created.ok, false);
	assert.equal(created.error.code, "refused");
	assert.match(created.error.message, /owner/);
	assert.equal(fake.api.requests.filter(({ method }) => method === "POST").length, 0);
	const run = (await provider.create({ image: "macos", lifetimeMs: 30 * 60_000, network: "open", labels: LABELS })).value;
	assert.match((await provider.release(run, "detach")).error.message, /a run's computer/);
});

test("Orgo Linux: an agent's computer's init takes the most this provider gives; detach suspends it with its memory; list reads the ledger, waking nothing; attach under a claim resumes it, init still there", async () => {
	const { api, channel, provider, ledger } = linux();
	const created = await provider.create({ image: "linux", network: "none", labels: LABELS, owner: OWNER });
	assert.equal(created.ok, true, JSON.stringify(created));
	const ref = created.value;
	assert.match(ref.name, /^computer-[0-9a-f]{12}-o[a-z2-7]{16}$/);
	const record = api.computers.get(ref.id);
	assert.equal(record.asked.ends_in_hours, undefined);
	const box = channel.boxOf(ref.id);
	const file = JSON.parse(box.labels);
	assert.deepEqual([file.deadline, file.maxDeadline, file.labels["agentrun.owner"]], ["none", "none", OWNER_VALUE]);
	assert.ok(Date.parse(box.init.deadline) > Date.now() + 700 * HOUR, `init's deadline is the provider's most: ${box.init.deadline}`);
	assert.deepEqual(ledger.rows.get(ref.id).labels, { ...LABELS, "agentrun.owner": OWNER_VALUE });

	assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
	assert.equal(record.status, "suspended");
	assert.equal(calls(api, "suspend").length, 1);
	const before = channel.calls.length;
	const listed = (await provider.list({ "agentrun.owner": OWNER_VALUE, team: "a" })).value;
	assert.equal(channel.calls.length, before, "a suspended one is not woken to read its labels file");
	assert.deepEqual(listed.map(({ state, labels }) => [state, labels.team]), [["stopped", "a"]]);
	assert.ok(listed[0].detachedAt instanceof Date);
	assert.equal((await provider.list({ "agentrun.owner": OWNER_VALUE, team: "b" })).value.length, 0);

	const attached = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(calls(api, "resume").length, 1);
	assert.deepEqual(attached.value.spec.owner, OWNER);
	assert.equal(record.status, "running");
	assert.equal(attached.value.spec.deadline, undefined);
	assert.deepEqual([JSON.parse(box.labels).labels["agentrun.epoch"], ledger.rows.get(ref.id).labels["agentrun.run"], ledger.rows.get(ref.id).detachedAt], ["2", "run-2", undefined]);
	assert.match((await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 1 } })).error.message, /fenced/);
	assert.equal((await provider.extend(ref, HOUR)).error.code, "refused");
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
	assert.equal(ledger.rows.has(ref.id), false);
});

const linuxSpec = (extra = {}) => ({ image: "linux", network: "none", labels: LABELS, owner: OWNER, ...extra });

test("Orgo Linux check(): an agent's spec takes no lifetime; owner is { agent }; the owner and idle-TTL labels are the provider's own", () => {
	const { provider } = linux();
	assert.deepEqual(provider.check(linuxSpec()), []);
	assert.ok(provider.check(linuxSpec({ lifetimeMs: 30 * 60_000 })).some(({ field }) => field === "lifetimeMs"), "an agent's computer has no run deadline");
	assert.ok(provider.check({ image: "linux", network: "none" }).some(({ field }) => field === "lifetimeMs"), "a run's computer still needs one");
	for (const owner of ["agent-7", { agent: "" }]) {
		assert.ok(provider.check(linuxSpec({ owner })).some(({ field }) => field === "owner"), JSON.stringify(owner));
	}
	for (const label of ["agentrun.owner", "agentrun.idle-ttl-ms"]) {
		assert.ok(provider.check(linuxSpec({ labels: { ...LABELS, [label]: "x" } })).some(({ field, message }) => field === "labels" && /provider's own/.test(message)), label);
	}
});

test("Orgo Linux: an owner that names its server: one agent id on two servers is two hashes, each listed by its own filter alone, and attached with no drift", async () => {
	const api = fakeOrgoApi();
	const channel = fakeOrgoChannel();
	const ledger = storeLedger();
	const { provider } = linux({ api, channel, ledger });
	const mine = { agent: "agent-7", server: "0123456789ab" };
	const theirs = { agent: "agent-7", server: "ba9876543210" };
	const a = (await provider.create(linuxSpec({ owner: mine }))).value;
	const b = (await provider.create(linuxSpec({ owner: theirs }))).value;
	assert.notEqual(a.name.split("-o")[1], b.name.split("-o")[1], "two owner hashes");
	assert.match(a.name, /^computer-[0-9a-f]{12}-o[a-z2-7]{16}$/);
	assert.deepEqual(ledger.rows.get(a.id).labels["agentrun.owner-server"], "0123456789ab");
	const listed = (await provider.list(ownerFilter(mine))).value;
	assert.deepEqual(listed.map((info) => [info.ref.id, info.owner]), [[a.id, mine]]);
	assert.deepEqual((await provider.list({ "agentrun.owner-server": "0123456789ab" })).value.map((info) => info.ref.id), [a.id], "the server's label alone lists its own agents' computers");
	await provider.release(a, "detach");
	const attached = await provider.attach({ id: a.id }, { claim: { run: "run-2", epoch: 1 } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.owner, mine);
	for (const ref of [a, b]) assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
});

test("Orgo Linux: a second detach of a suspended computer is done and keeps when it was first detached; a connect never resumes it; its ledger outlives the provider", async () => {
	const api = fakeOrgoApi();
	const channel = fakeOrgoChannel();
	const ledger = storeLedger();
	const first = linux({ api, channel, ledger }).provider;
	const ref = (await first.create(linuxSpec())).value;
	assert.deepEqual(await first.release(ref, "detach"), { ok: true, value: undefined });
	const at = ledger.rows.get(ref.id).detachedAt;
	assert.ok(typeof at === "string" && !Number.isNaN(Date.parse(at)), String(at));
	assert.deepEqual(await first.release(ref, "detach"), { ok: true, value: undefined });
	assert.equal(ledger.rows.get(ref.id).detachedAt, at);
	assert.equal(calls(api, "suspend").length, 1, "a suspended one is not suspended again");
	assert.equal((await first.connect(ref)).error.code, "refused", "a connect does not resume it: attach does");
	assert.equal(calls(api, "resume").length, 0);

	// A new provider over the same ledger, as a restarted server: it lists the agent's computer and attaches it.
	const second = linux({ api, channel, ledger }).provider;
	const [listed] = (await second.list({ "agentrun.owner": OWNER_VALUE })).value;
	assert.deepEqual([listed.ref.id, listed.state, listed.owner, listed.detachedAt?.toISOString()], [ref.id, "stopped", OWNER, at]);
	const attached = await second.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 1 } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(calls(api, "resume").length, 1);
	assert.equal((await second.connect(ref)).ok, true);
	assert.deepEqual(await second.release(ref, "delete"), { ok: true, value: undefined });
});

test("Orgo Linux: an agent's computer with no ledger entry has unknown labels: listed owned with no owner to an unfiltered list alone, kept by the janitor, never attached or detached, and deleted on request", async () => {
	const api = fakeOrgoApi();
	const channel = fakeOrgoChannel();
	const ref = (await linux({ api, channel }).provider.create(linuxSpec())).value;
	const { provider, ledger } = linux({ api, channel });
	assert.deepEqual((await provider.list({})).value.map((info) => [info.ref.id, info.labels, info.owned, info.owner]), [[ref.id, {}, true, undefined]]);
	assert.deepEqual((await provider.list({ "agentrun.owner": OWNER_VALUE })).value, [], "no label is proved without the entry, its owner's neither");
	const swept = await sweep(provider, { now: new Date(Date.now() + 10_000 * HOUR), ownerGone: () => true });
	assert.deepEqual(swept, { ok: true, value: { deleted: [], kept: 1 } }, "an owner the janitor cannot read keeps the computer");

	const ran = channel.calls.length;
	for (const [what, result] of [
		["attach", await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } })],
		["detach", await provider.release(ref, "detach")],
	]) {
		assert.equal(result.error?.code, "refused", what);
		assert.match(result.error.message, /no entry in the provider's ledger.*release it with delete/, what);
	}
	assert.equal(channel.calls.length, ran, "nothing ran in it");
	assert.deepEqual([calls(api, "suspend").length, api.computers.get(ref.id).status, ledger.rows.size], [0, "running", 0], "nothing changed");
	assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
});

test("Orgo Linux: the janitor deletes an agent's computer only when its owner is gone or it has idled past its TTL, never by a deadline", async () => {
	const { provider } = linux();
	const ref = (await provider.create(linuxSpec({ owner: { agent: "agent-7", idleTtlMs: HOUR } }))).value;
	const far = new Date(Date.now() + 1_000 * HOUR);
	assert.deepEqual(await sweep(provider, { now: far, ownerGone: () => false }), { ok: true, value: { deleted: [], kept: 1 } }, "running, held: kept whatever the time");
	await provider.release(ref, "detach");
	assert.deepEqual(await sweep(provider, { ownerGone: () => false }), { ok: true, value: { deleted: [], kept: 1 } }, "detached, within its TTL");
	assert.deepEqual(await sweep(provider, { now: new Date(Date.now() + 2 * HOUR), ownerGone: () => false }), { ok: true, value: { deleted: [ref.name], kept: 0 } }, "detached past its TTL");

	const other = linux();
	const held = (await other.provider.create(linuxSpec())).value;
	assert.deepEqual(await sweep(other.provider, { now: far, ownerGone: ({ agent }) => agent === "agent-7" }), { ok: true, value: { deleted: [held.name], kept: 0 } }, "its owner gone");
});

test("Orgo Linux: a run's computer is never detached, never taken under a claim, and one that is not running is never woken by attach", async () => {
	const { api, provider } = linux();
	const created = (await provider.create({ image: "linux", lifetimeMs: 30 * 60_000, network: "none", labels: LABELS })).value;
	const detached = await provider.release(created, "detach");
	assert.equal(detached.ok, false);
	assert.match(detached.error.message, /a run's computer, not an agent's own/);
	assert.equal(api.computers.get(created.id).status, "running", "it runs on");
	const claimed = await provider.attach({ id: created.id }, { claim: { run: "run-2", epoch: 2 } });
	assert.equal(claimed.error.code, "refused");
	assert.match(claimed.error.message, /a run's computer/);
	assert.equal((await provider.list({ "agentrun.owner": OWNER_VALUE })).value.length, 0, "an owner's listing never finds a run's computer");
	api.computers.get(created.id).status = "suspended";
	assert.equal((await provider.attach({ id: created.id })).error.code, "refused");
	assert.deepEqual([calls(api, "resume").length, calls(api, "start").length], [0, 0]);
});

/** A gate that holds the first swap `when` picks until open() is called; reached resolves once that swap is held. */
function holdOnce(when) {
	let reached;
	let open;
	const held = { reached: new Promise((done) => (reached = done)), opened: new Promise((done) => (open = done)), open: () => open(), taken: false };
	held.gate = (was, entry) => {
		if (held.taken || !when(was, entry)) return undefined;
		held.taken = true;
		reached();
		return held.opened;
	};
	return held;
}

const OWNED_MAX = "9999-12-31T23:59:59.000Z";
const epochOf = (entry) => entry.labels["agentrun.epoch"];

test("Orgo: two attaches of one agent's computer under one run's claims at epochs 1 and 2 race; whichever ledger write of the epoch-1 attach lands last, the ledger ends at epoch 2 and the epoch-1 attach is refused (Linux and Windows)", async () => {
	const kinds = [
		["linux", (ledger) => { const made = linux({ ledger }); return { provider: made.provider, api: made.api, spec: linuxSpec(), wake: "resume" }; }],
		["windows", (ledger) => { const made = desktop("windows", { ledger }); return { provider: made.provider, api: made.fake.api, spec: windowsSpec(), wake: "start" }; }],
	];
	// The epoch-1 attach's take (run-1's entry to run-2's at epoch 1), or its mark as held (after its take and checks).
	const holds = [
		["its take", (was, entry) => epochOf(entry) === "1" && was.labels["agentrun.run"] === "run-1"],
		["its mark as held", (was, entry) => epochOf(entry) === "1" && was.labels["agentrun.run"] === "run-2" && was.detachedAt !== undefined && entry.detachedAt === undefined],
	];
	for (const [os, make] of kinds) {
		for (const [what, when] of holds) {
			const held = holdOnce(when);
			const ledger = storeLedger({ gate: held.gate });
			const { provider, api, spec, wake } = make(ledger);
			const ref = (await provider.create(spec)).value;
			assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
			const lower = provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 1 } });
			await held.reached;
			const higher = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } });
			assert.equal(higher.ok, true, `${os}, ${what}: ${JSON.stringify(higher)}`);
			held.open();
			const lost = await lower;
			assert.equal(lost.ok, false, `${os}, ${what}`);
			assert.equal(lost.error.code, "refused");
			assert.match(lost.error.message, /fenced/, `${os}, ${what}`);
			const row = ledger.rows.get(ref.id);
			assert.deepEqual([row.labels["agentrun.run"], epochOf(row), row.detachedAt], ["run-2", "2", undefined], `${os}, ${what}: the higher epoch stays`);
			assert.equal(api.computers.get(ref.id).status, "running", `${os}, ${what}: the epoch-2 attach's computer runs on`);
			assert.equal(calls(api, wake).length, 1, `${os}, ${what}: woken once`);
			assert.equal(calls(api, wake === "resume" ? "suspend" : "stop").length, 1, `${os}, ${what}: the lost attach put nothing back`);
		}
	}
});

test("Orgo Linux: an agent's computer's init starts with a most that is none in practice, and each attach moves its deadline maxLifetimeMs out", async () => {
	const { channel, provider } = linux();
	const ref = (await provider.create(linuxSpec())).value;
	const box = channel.boxOf(ref.id);
	assert.equal(box.init.max, OWNED_MAX);
	const first = Date.parse(box.init.deadline);
	assert.ok(first > Date.now() + 719 * HOUR && first <= Date.now() + 720 * HOUR, box.init.deadline);
	assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
	// Suspend keeps init and the deadline it had; an hour left of it, as after a long first run and detach.
	box.init.deadline = new Date(Date.now() + HOUR).toISOString();
	const before = Date.now();
	const attached = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 1 } });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.equal(box.extended.length, 1, "deadline.extend, once");
	assert.ok(Date.parse(box.init.deadline) >= before + 720 * HOUR, `moved maxLifetimeMs out: ${box.init.deadline}`);
	assert.equal(box.stopped, undefined, "the daemon answered at this version: it was kept");
});

test("Orgo Linux: an attach that finds an agent's computer's daemon of another version, or none answering, stops the old init, installs this provider's daemon again and attaches, the computer kept; a run's computer is refused instead", async () => {
	const { api, channel, provider } = linux();
	const ref = (await provider.create(linuxSpec())).value;
	const box = channel.boxOf(ref.id);
	const uploads = () => channel.calls.filter(({ op, computer }) => op === "upload" && computer === ref.id).length;
	assert.equal(uploads(), 1);
	assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
	box.init.version = "0.0.1";
	const upgraded = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 1 } });
	assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
	assert.equal(box.stopped, 1, "the old init stopped");
	assert.equal(uploads(), 2, "the daemon uploaded again");
	assert.deepEqual([box.init.version, box.init.max], [undefined, OWNED_MAX], "a new init, this version, no most in practice");
	assert.match(upgraded.value.notes[0], /daemon in .* was replaced .* its disk kept, since its daemon was version 0\.0\.1/);
	assert.deepEqual([upgraded.value.id, api.computers.get(ref.id).status, JSON.parse(box.labels).labels["agentrun.epoch"]], [ref.id, "running", "1"], "the same computer, its labels file carrying the claim");

	assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
	box.init = undefined; // init ended at its deadline while the desktop was detached
	const revived = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } });
	assert.equal(revived.ok, true, JSON.stringify(revived));
	assert.equal(box.stopped, 2);
	assert.match(revived.value.notes[0], /did not answer/);
	assert.equal(api.requests.filter(({ method, path }) => method === "POST" && path === "/computers").length, 1, "never a new computer");

	const run = (await provider.create({ image: "linux", lifetimeMs: 30 * 60_000, network: "none", labels: LABELS })).value;
	channel.boxOf(run.id).init.version = "0.0.1";
	const refused = await provider.attach({ id: run.id });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /version "?0\.0\.1/);
	assert.equal(channel.boxOf(run.id).stopped, undefined, "a run's daemon is never replaced");
});

test("Orgo: an attach that wakes an agent's computer and then fails a check suspends (Linux) or stops (Windows) it again, as it was found; one refused before the wake wakes nothing", async () => {
	const other = "computer-0123456789ab-oaaaaaaaaaaaaaaaa";
	const kinds = [
		["linux", () => {
			const made = linux();
			return { ...made, spec: linuxSpec(), wake: "resume", sleep: "suspend", asleep: "suspended", tamper: (id) => { const box = made.channel.boxOf(id); const file = box.labels; box.labels = JSON.stringify({ ...JSON.parse(file), name: other }); return () => void (box.labels = file); } };
		}],
		["windows", () => {
			const made = desktop("windows");
			return { ...made, api: made.fake.api, spec: windowsSpec(), wake: "start", sleep: "stop", asleep: "frozen", tamper: (id) => { const files = made.fake.boxOf(id).files; const file = files.get(WINDOWS_LABELS); files.set(WINDOWS_LABELS, Buffer.from(JSON.stringify({ ...JSON.parse(file.toString("utf8")), name: other }))); return () => void files.set(WINDOWS_LABELS, file); } };
		}],
	];
	for (const [os, make] of kinds) {
		const { api, provider, ledger, spec, wake, sleep, asleep, tamper } = make();
		const ref = (await provider.create(spec)).value;
		assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
		const detachedAt = ledger.rows.get(ref.id).detachedAt;
		const restore = tamper(ref.id);
		const failed = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 1 } });
		assert.equal(failed.error?.code, "refused", os);
		assert.match(failed.error.message, /does not match this provider.*again, as it was found/, os);
		assert.deepEqual([calls(api, wake).length, calls(api, sleep).length, api.computers.get(ref.id).status], [1, 2, asleep], `${os}: woken, then put back`);
		assert.equal(ledger.rows.get(ref.id).detachedAt, detachedAt, `${os}: still detached since then`);

		restore();
		assert.equal((await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 3 } })).ok, true, os);
		assert.deepEqual(await provider.release(ref, "detach"), { ok: true, value: undefined });
		const fenced = await provider.attach({ id: ref.id }, { claim: { run: "run-2", epoch: 2 } });
		assert.match(fenced.error?.message ?? "", /fenced/, os);
		assert.deepEqual([calls(api, wake).length, calls(api, sleep).length, api.computers.get(ref.id).status], [2, 3, asleep], `${os}: a fenced claim woke nothing and put nothing back`);
	}
});

// provider.persistence (Full) runs in the computer (env, files, a process): the Linux fake has no daemon to run it, and
// the case is written for a POSIX shell, so on Windows it skips. It runs live; the tests above cover the same steps.
test("the conformance suite's Core persistence cases, provider.owner and provider.detach, pass on the Linux, Windows and macOS fakes", async () => {
	const { runConformance, conformanceCases } = await import("../dist/conformance/index.js");
	const cases = conformanceCases.filter(({ id }) => ["provider.owner", "provider.detach"].includes(id));
	assert.equal(cases.length, 2);
	for (const [image, provider] of [
		["linux", linux().provider],
		["windows", desktop("windows").provider],
		["macos", desktop("macos").provider],
	]) {
		const report = await runConformance(provider, { image, cases, patience: 5_000, caseTimeoutMs: 60_000 });
		const statuses = Object.fromEntries(report.results.map(({ id, status, reason }) => [id, status === "pass" ? status : `${status}: ${reason}`]));
		assert.deepEqual(statuses, { "provider.owner": "pass", "provider.detach": "pass" }, image);
		assert.deepEqual(report.cleanup.left, [], image);
	}
});
