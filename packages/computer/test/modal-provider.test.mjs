// ModalProvider without a vendor fake: what Modal's own host decides (its capabilities, its check, the 512 bytes of
// tags, what sandboxes.create is handed, the token and the server on every client, the environment it reads and
// refuses, the conformance module's names), each read from options or from what the SDK slice is handed. The adapter's
// lifecycle is tested once, against its one fake host (hosted-provider.test.mjs); Modal's own lifecycle is proven live
// (test/modal). The SDK slice here only records what it is given and answers nothing that makes a sandbox: no sandbox
// exists, no Modal client is constructed unless a test says so, and nothing reaches the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLifetime, kindRefusals, sweep } from "../dist/index.js";
import { fakeObjects } from "./fake-archil.mjs";

const modal = await import("../dist/modal.js");
const { ModalProvider, labelsOf, tagsOf } = modal;

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const APP = "computers";
const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRYPOINT_MARK = "# agentrun-computer: entrypoint";
const dir = mkdtempSync(join(tmpdir(), "computer-modal-"));
const DAEMON_PATH = join(dir, "computerd-linux-amd64");
writeFileSync(DAEMON_PATH, Buffer.from("a stand-in for computerd, linux/amd64\n"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** Short bounds, so the waits in these tests take milliseconds. */
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500 };

class InvalidError extends Error {
	name = "InvalidError";
}

/**
 * The SDK's slice as a recorder: every call records its name and arguments. apps.fromName answers an app; images
 * answer an image whose dockerfileCommands records its lines; sandboxes.list lists nothing; sandboxes.create records
 * its params and throws InvalidError, as Modal refuses a create, so nothing is ever made. With refuse, every call
 * throws gRPC's UNAUTHENTICATED, as Modal does for a token it refuses. It shows what the provider gives the SDK, never
 * how Modal behaves.
 */
function recorder({ refuse = false } = {}) {
	const calls = [];
	const denied = () => Object.assign(new Error("Token missing or invalid"), { code: 16 });
	const record =
		(name, answer) =>
		(...args) => {
			calls.push([name, ...args]);
			if (refuse) throw denied();
			return answer(...args);
		};
	const image = (from) => ({ from, dockerfileCommands: record("image.dockerfileCommands", (lines) => ({ from, lines })) });
	const sdk = {
		apps: { fromName: record("apps.fromName", async (name) => ({ appId: `ap-${name}` })) },
		images: { fromRegistry: record("images.fromRegistry", (tag) => image(tag)), fromId: record("images.fromId", async (id) => image(id)) },
		sandboxes: {
			create: record("sandboxes.create", async () => {
				throw new InvalidError("400: the image could not be pulled");
			}),
			fromId: record("sandboxes.fromId", async () => {
				throw Object.assign(new Error("Sandbox not found"), { name: "NotFoundError" });
			}),
			list: record("sandboxes.list", () => ({ async *[Symbol.asyncIterator]() {} })),
		},
	};
	return { calls, sdk, params: () => calls.find(([name]) => name === "sandboxes.create")?.[3], names: () => calls.map(([name]) => name) };
}

function setup(options = {}, recorderOptions = {}) {
	const rec = recorder(recorderOptions);
	const provider = new ModalProvider({ sdk: rec.sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS, ...options });
	return { rec, provider };
}
let requests = 0;
const create = (provider, spec = SPEC) => provider.create(spec, { requestId: `req-modal-${++requests}` });
const bytesOf = (tags) => Object.entries(tags).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);

/** Runs fn with these names set in process.env (undefined: unset), where the SDK reads them, and puts back what was there. */
async function withProcessEnv(values, fn) {
	const before = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [name, value] of Object.entries(before)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

// --- what a Modal computer is ---

test("capabilities, as before the move: a linux VM whose lifetime Modal enforces up to 24 hours, init its main process, network none alone with no read-back, a uid, no agent port, GPUs on gVisor", () => {
	const { provider, rec } = setup();
	assert.equal(provider.id, "modal");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		kind: "linux",
		lifetime: "vendor",
		network: ["none"],
		networkReadBack: false,
		isolation: "vm",
		os: "linux",
		daemon: "pid1",
		groups: ["exec", "files", "processes"],
		maxLifetimeMs: DAY_MS,
		user: ["uid"],
		release: ["delete"],
		mount: ["archil"],
		vendorAgentPorts: [],
		gpu: {
			types: ["T4", "L4", "A10", "L40S", "A100", "A100-40GB", "A100-80GB", "RTX-PRO-6000", "H100", "H200", "B200", "B300"],
			max: 8,
			isolation: "gvisor",
			preemptible: true,
			mounts: [],
			unmounted: { why: "Archil's FUSE mount isn't proven on Modal's gVisor runtime (#2279)", yet: true },
			fence: "userns-netns",
		},
	});
	assert.deepEqual(modal.CAPABILITIES[0].gpu, provider.capabilities().gpu, "the static configuration declares the same GPUs");
	assert.deepEqual([...modal.MOUNT], ["archil"]);
	assert.deepEqual(kindRefusals(provider.capabilities()), []);
	assert.equal(provider.extend, undefined, "no extend(): Modal's timeout cannot move");
	assert.equal(provider.stream, undefined, "no stream()");
	assert.deepEqual(rec.calls, []);
});

test("the constructor refuses, in words, what would make a computer it cannot vouch for", () => {
	const make = (options) => () => new ModalProvider({ sdk: recorder().sdk, app: APP, ...options });
	assert.throws(() => new ModalProvider({ sdk: {}, app: APP }), /options\.sdk must be a Modal client; it lacks apps\.fromName/);
	for (const app of [undefined, "", " "]) assert.throws(make({ app }), /options\.app/);
	for (const maxLifetimeMs of [0, -1, 1.5, DAY_MS + 1, "1800000"]) assert.throws(make({ maxLifetimeMs }), /maxLifetimeMs/, String(maxLifetimeMs));
	for (const daemonUser of ["0:0", "00:1000", "1000:0"]) assert.throws(make({ daemonUser }), /root or in root's group/, daemonUser);
	assert.throws(make({ daemonUser: "1000" }), /uid:gid in numbers/);
	assert.throws(make({ probeTargets: ["example.com"] }), /host:port or host:port\/udp/);
	assert.throws(make({ timeouts: { createMs: 1.5 } }), /timeouts\.createMs must be a whole number/);
});

test("check() takes a spec it can make, with no SDK call", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, cpus: 0.5, memoryMb: 512, labels: { team: "a", run: "r1" }, user: "65534" }), []);
	assert.deepEqual(provider.check({ ...SPEC, user: "1000:0" }), [], "root's group, without root, is not root");
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: DAY_MS, user: "65534:65534" }), []);
	assert.deepEqual(provider.check({ ...SPEC, image: "im-0123456789abcdef" }), [], "an image Modal holds, by its id");
	assert.deepEqual(provider.check({ ...SPEC, gpu: { type: "H100", count: 8 } }), []);
	assert.deepEqual(rec.calls, []);
});

test("check() refuses in words, field by field, with no SDK call", () => {
	const { provider, rec } = setup();
	const refused = (spec) => provider.check(spec).map((r) => r.field);
	const words = (spec, field) => provider.check(spec).find((r) => r.field === field)?.message ?? "";
	for (const image of [undefined, "", "-x", "debian bookworm", "debian\0"]) assert.deepEqual(refused({ ...SPEC, image }), ["image"], `image ${JSON.stringify(image)}`);
	for (const lifetimeMs of [undefined, 0, 1.5, DAY_MS + 1]) {
		assert.deepEqual(provider.check({ ...SPEC, lifetimeMs }), checkLifetime(lifetimeMs, provider.capabilities()), `lifetimeMs ${String(lifetimeMs)}: the shared rule's words`);
	}
	for (const network of ["open", { allow: ["8.8.8.0/24"] }]) {
		assert.deepEqual(refused({ ...SPEC, network }), ["network"], `network ${JSON.stringify(network)}`);
		assert.match(words({ ...SPEC, network }, "network"), /network "none" only/);
	}
	for (const cpus of [0, -1, 0.1, "2", Number.NaN]) assert.deepEqual(refused({ ...SPEC, cpus }), ["cpus"], `cpus ${String(cpus)}`);
	assert.match(words({ ...SPEC, cpus: 0.1 }, "cpus"), /Modal counts physical cores, 2 CPUs each/);
	for (const memoryMb of [0, 1.5, "512"]) assert.deepEqual(refused({ ...SPEC, memoryMb }), ["memoryMb"], `memoryMb ${String(memoryMb)}`);
	assert.deepEqual(refused({ ...SPEC, pids: 64 }), ["pids"]);
	// A Modal computer works in its home: the daemon's working directory is read back as /work.
	assert.deepEqual(refused({ ...SPEC, workdir: "/opt/app" }), ["workdir"]);
	assert.match(words({ ...SPEC, workdir: "/opt/app" }, "workdir"), /works in \/work, its home/);
	// Ten tags, five of them the adapter's own: a computer takes five labels of its caller's.
	const six = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`l${n}`, "v"]));
	assert.deepEqual(refused({ ...SPEC, labels: six }), ["labels"]);
	assert.match(words({ ...SPEC, labels: six }, "labels"), /a Modal computer takes 10 labels, 5 of them the provider's own: 6 is 1 too many/);
	assert.deepEqual(provider.check({ ...SPEC, labels: Object.fromEntries(Object.entries(six).slice(1)) }), []);
	for (const labels of [{ [COMPUTER]: "x" }, { [NAME]: "x" }, { a: 1 }, { "": "v" }, { "a\0": "v" }, []]) {
		assert.deepEqual(refused({ ...SPEC, labels }), ["labels"], `labels ${JSON.stringify(labels)}`);
	}
	for (const user of ["alice", "root", "0", "-1", "1000:", "4294967295"]) assert.deepEqual(refused({ ...SPEC, user }), ["user"], `user ${user}`);
	assert.match(words({ ...SPEC, user: "0" }, "user"), /a Modal computer does not run as root/);
	for (const gpu of ["A100", { type: "A100" }, { type: "V100", count: 1 }, { type: "H100!", count: 1 }, { type: "T4", count: 0 }, { type: "T4", count: 9 }]) {
		assert.deepEqual(refused({ ...SPEC, gpu }), ["gpu"], `gpu ${JSON.stringify(gpu)}`);
	}
	assert.deepEqual(refused({ ...SPEC, region: "us-east-1" }), ["region"]);
	assert.deepEqual(rec.calls, [], "check made no SDK call");
});

test("lifetime: maxLifetimeMs caps what check takes, in words, and create refuses past it before any SDK call", async () => {
	const { provider, rec } = setup({ maxLifetimeMs: 30 * 60_000 });
	assert.equal(provider.capabilities().maxLifetimeMs, 30 * 60_000, "the instance's cap is the one it declares");
	assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: 30 * 60_000 }), []);
	const refusals = provider.check({ ...SPEC, lifetimeMs: 30 * 60_000 + 1 });
	assert.deepEqual(refusals, checkLifetime(30 * 60_000 + 1, provider.capabilities()));
	assert.match(refusals[0].message, /at most 30 min \(1800000 ms\)/);
	const refused = await create(provider, { ...SPEC, lifetimeMs: 60 * 60_000 });
	assert.equal(refused.error?.code, "refused");
	assert.match(refused.error.message, /lifetimeMs: .*30 min/);
	const root = await create(provider, { ...SPEC, user: "0" });
	assert.equal(root.error?.code, "refused");
	assert.deepEqual(rec.calls, [], "refused before any SDK call");
});

test("the janitor does not sweep Modal computers: Modal ends them at their lifetime", async () => {
	const { provider, rec } = setup();
	const swept = await sweep(provider);
	assert.equal(swept.error?.code, "refused");
	assert.deepEqual(rec.calls, []);
});

// --- what sandboxes.create is handed ---

test("create asks Modal for one VM sandbox in the app: the entrypoint as its command, init --own-network as 2510:2510, the lifetime as its timeout in whole seconds, Modal's small request under the spec's limits, no network, the labels as tags", async () => {
	const { provider, rec } = setup();
	const result = await create(provider, { ...SPEC, lifetimeMs: 600_500, labels: { team: "a" } });
	assert.equal(result.error?.code, "invalid", "a create Modal refused made nothing");
	assert.deepEqual(rec.names().slice(0, 2), ["apps.fromName", "sandboxes.list"], "the listing by the request's name comes first");
	const [, listed] = rec.calls.find(([name]) => name === "sandboxes.list");
	assert.deepEqual(Object.keys(listed.tags).sort(), [COMPUTER, NAME]);
	assert.deepEqual(rec.calls.find(([name]) => name === "apps.fromName").slice(1), [APP, { createIfMissing: true }]);
	assert.deepEqual(rec.calls.find(([name]) => name === "images.fromRegistry").slice(1), ["debian:bookworm-slim"]);
	assert.deepEqual(rec.calls.find(([name]) => name === "image.dockerfileCommands")[1], ["ENV HOME=/work", "WORKDIR /work"]);
	const params = rec.params();
	assert.equal(params.runtime, "vm");
	assert.equal(params.gpu, undefined);
	assert.equal(params.timeoutMs, 601_000, "whole seconds: up, never under the lifetime");
	assert.equal(params.workdir, "/work");
	assert.deepEqual([params.cpu, params.cpuLimit, params.memoryMiB, params.memoryLimitMiB], [0.125, 1, 128, 4096], "2 CPUs are 1 core; Modal's default request under the limits");
	assert.equal(params.blockNetwork, true);
	assert.deepEqual(params.command.slice(0, 2), ["sh", "-c"]);
	assert.ok(params.command[2].startsWith(`${ENTRYPOINT_MARK}\n`));
	assert.deepEqual([params.command[4], params.command[6]], ["/opt/agentrun/computerd", "/work"]);
	const init = params.command.slice(params.command.indexOf("init"));
	assert.equal(init[init.indexOf("--user") + 1], "2510:2510");
	assert.ok(init.includes("--own-network"));
	assert.equal(params.tags.team, "a");
	assert.equal(params.tags[COMPUTER], "1");
	assert.match(params.tags[NAME], /^computer-[0-9a-f]{12}$/);
	assert.deepEqual(Object.keys(params.tags).sort(), ["agentrun.computer", "agentrun.computer.deadline", "agentrun.computer.image", "agentrun.computer.max-deadline", "agentrun.computer.name", "team"]);
	assert.ok(!rec.names().includes("sandboxes.fromId"), "nothing was made, so nothing is read back");
});

test("create: a spec's sizes and user map onto Modal's fields and init's --user", async () => {
	const { provider, rec } = setup();
	await create(provider, { ...SPEC, cpus: 0.5, memoryMb: 512, user: "65534" });
	const params = rec.params();
	assert.deepEqual([params.cpu, params.cpuLimit, params.memoryMiB, params.memoryLimitMiB], [0.125, 0.25, 128, 512]);
	const init = params.command.slice(params.command.indexOf("init"));
	assert.equal(init[init.indexOf("--user") + 1], "65534:65534", "a uid alone is its own gid");
	const tiny = setup();
	await create(tiny.provider, { ...SPEC, cpus: 0.25, memoryMb: 64 });
	assert.deepEqual([tiny.rec.params().cpu, tiny.rec.params().memoryMiB], [0.125, 64], "the request never above the limit");
});

test("create of a GPU computer: Modal's GPU option, on its gVisor runtime", async () => {
	for (const [gpu, given] of [
		[{ type: "T4", count: 1 }, "T4"],
		[{ type: "H100", count: 8 }, "H100:8"],
	]) {
		const { provider, rec } = setup();
		await create(provider, { ...SPEC, gpu });
		assert.equal(rec.params().runtime, "gvisor");
		assert.equal(rec.params().gpu, given);
	}
});

test("create opens an image Modal holds (im-...) by its id, never as a registry tag; an SDK with no images.fromId is refused in words", async () => {
	const { provider, rec } = setup();
	await create(provider, { ...SPEC, image: "im-0123456789abcdef" });
	assert.deepEqual(rec.calls.find(([name]) => name === "images.fromId").slice(1), ["im-0123456789abcdef"]);
	assert.ok(!rec.names().includes("images.fromRegistry"));
	const bare = recorder();
	const { fromId: _fromId, ...registryOnly } = bare.sdk.images;
	bare.sdk.images = registryOnly;
	const refused = await create(new ModalProvider({ sdk: bare.sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }), { ...SPEC, image: "im-0123456789abcdef" });
	assert.equal(refused.error?.code, "invalid");
	assert.match(refused.error.message, /has no images\.fromId to open it/);
	assert.ok(!bare.names().includes("sandboxes.create"));
});

// --- the Archil run folder, and Modal's 512 bytes of tags ---

const TOKEN = "tok-modal-archil-0123456789abcdef";
const RUN = "01a1d0b9-3e8b-7352-9497-a407e2909f53";
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: `agents/a1/runs/${RUN}/work`, token: TOKEN };
const ARCHIL_SPEC = { ...SPEC, labels: { "agentrun.run": RUN, "agentrun.epoch": "1" }, mount: MOUNT };
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);

test("check(): an Archil spec takes network none, the run and epoch labels, the helper's shapes and the tool user, with no SDK call; no refusal holds the token", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.check(ARCHIL_SPEC), []);
	assert.deepEqual(provider.check({ ...ARCHIL_SPEC, user: "2510:2510" }), [], "the tool user, named");
	const cases = [
		[{ network: "open" }, "network", /none/],
		[{ labels: { "agentrun.run": RUN } }, "labels", /agentrun\.epoch/],
		[{ mount: { ...MOUNT, folder: "agents/a1/runs/r2/work" } }, "mount", /run r2/],
		[{ mount: { ...MOUNT, token: "short" } }, "mount", /mount\.token/],
		[{ user: "1000:1000" }, "user", /2510/],
		[{ gpu: { type: "T4", count: 1 } }, "gpu", /mount/],
		[{ labels: { ...ARCHIL_SPEC.labels, "agentrun.mount": "{}" } }, "labels", /the provider's own/],
	];
	for (const [change, field, pattern] of cases) {
		const refusals = provider.check({ ...ARCHIL_SPEC, ...change });
		assert.ok(refusals.some((r) => r.field === field && pattern.test(r.message)), `${JSON.stringify(change)}: ${JSON.stringify(refusals).replaceAll(TOKEN, "[token]")}`);
		noToken(refusals, `the refusal of ${field}`);
	}
	assert.deepEqual(rec.calls, [], "no SDK call");
});

test("create of an Archil computer: Modal's network stays on for root to reach Archil, and the mount's tag records the folder's agent alone, never the token", async () => {
	const { provider, rec } = setup();
	await create(provider, ARCHIL_SPEC);
	const { tags, blockNetwork } = rec.params();
	assert.equal(blockNetwork, undefined, "root reaches Archil; the tools' none is init's own, read from inside");
	assert.equal(tags["agentrun.mount"], JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, agent: "a1" }));
	assert.equal(labelsOf(tags)["agentrun.mount"], JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder }), "read back as the adapter wrote it");
	noToken(rec.calls, "what the SDK was handed");
});

test("tagsOf and labelsOf: only a mount label exactly as the adapter writes it, for the run its label names, is shortened, and it reads back the same", () => {
	const mount = (folder) => JSON.stringify({ kind: "archil", disk: "d", region: "r", folder });
	const labels = { "agentrun.run": "r1", "agentrun.mount": mount("agents/a1/runs/r1/work"), team: "x" };
	assert.deepEqual(labelsOf(tagsOf(labels)), labels);
	assert.equal(tagsOf(labels)["agentrun.mount"], '{"kind":"archil","disk":"d","region":"r","agent":"a1"}');
	for (const other of [
		{ "agentrun.run": "r2", "agentrun.mount": mount("agents/a1/runs/r1/work") },
		{ "agentrun.mount": mount("agents/a1/runs/r1/work") },
		{ "agentrun.run": "r1", "agentrun.mount": mount("elsewhere") },
		{ "agentrun.run": "r1", "agentrun.mount": `${mount("agents/a1/runs/r1/work")} ` },
		{ "agentrun.run": "r1", "agentrun.mount": "not json" },
		{ team: "x" },
	]) {
		assert.deepEqual(tagsOf(other), other, JSON.stringify(other));
		assert.deepEqual(labelsOf(tagsOf(other)), other, JSON.stringify(other));
	}
	// A tag of the short shape with no run label, or with more in it, is no mount the adapter wrote: left as it is.
	for (const tags of [{ "agentrun.mount": '{"kind":"archil","disk":"d","region":"r","agent":"a1"}' }, { "agentrun.run": "r1", "agentrun.mount": '{"kind":"archil","disk":"d","region":"r","agent":"a1","x":1}' }]) {
		assert.deepEqual(labelsOf(tags), tags);
	}
});

test("Modal's 512 bytes of tags: qa36's Archil computer and one of the longest agent id fit; past the bound check() refuses in words, before any SDK call", async () => {
	const archilSpec = (agent, image) => ({ ...SPEC, image, labels: { "agentrun.run": RUN, "agentrun.epoch": "1" }, mount: { ...MOUNT, folder: `agents/${agent}/runs/${RUN}/work` } });
	for (const spec of [archilSpec("qa35e-modal-mwdsumo1", "registry.example/agentrun-archil:qa36"), archilSpec("a".repeat(128), "debian:bookworm-slim")]) {
		const { provider, rec } = setup();
		assert.deepEqual(provider.check(spec), []);
		await create(provider, spec);
		const { tags } = rec.params();
		assert.ok(bytesOf(tags) <= 512, `${bytesOf(tags)} bytes of tags`);
		assert.equal(JSON.parse(labelsOf(tags)["agentrun.mount"]).folder, spec.mount.folder);
	}
	const { provider, rec } = setup();
	const over = archilSpec("a".repeat(128), `registry.example/agentrun-archil@sha256:${"b".repeat(64)}`);
	const refusals = provider.check(over);
	assert.equal(refusals.length, 1, JSON.stringify(refusals));
	assert.equal(refusals[0].field, "mount");
	assert.match(refusals[0].message, /a Modal sandbox's tags come to at most 512 bytes, names and values together, and this computer's would come to \d+ \(.*agentrun\.mount \d+.*\): give a shorter image, mount folder or labels/);
	noToken(refusals, "the refusal of the tags' size");
	const created = await create(provider, over);
	assert.equal(created.error?.code, "refused");
	const long = { ...SPEC, labels: { a: "x".repeat(480) } };
	assert.deepEqual(provider.check(long).map((r) => r.field), ["labels"], "a computer with no mount: the labels are the field");
	assert.deepEqual(rec.calls, [], "no SDK call");
});

test('the Modal conformance module: mountFor("archil") gives a fresh run folder on the disk COMPUTER_ARCHIL_* name, read and written outside through the disk\'s object API', async () => {
	const { ARCHIL_ENV, MODAL_ENV, mountFor } = await import("../dist/conformance/modal.js");
	assert.deepEqual(Object.values(ARCHIL_ENV), ["COMPUTER_ARCHIL_DISK", "COMPUTER_ARCHIL_REGION", "COMPUTER_ARCHIL_TOKEN", "COMPUTER_ARCHIL_API_KEY", "COMPUTER_ARCHIL_S3_URL"]);
	assert.equal(Object.values(MODAL_ENV).some((name) => name.startsWith("COMPUTER_ARCHIL_")), false, "the provider's settings name no Archil setting");
	const settings = {
		COMPUTER_ARCHIL_DISK: MOUNT.disk,
		COMPUTER_ARCHIL_REGION: MOUNT.region,
		COMPUTER_ARCHIL_TOKEN: TOKEN,
		COMPUTER_ARCHIL_API_KEY: "key-archil-account-0123456789abcdef",
		COMPUTER_ARCHIL_S3_URL: "https://s3.green.us-east-1.aws.prod.archil.com",
	};
	const env = { AGENTRUN_COMPUTER_LIVE_MODAL: "1", ...settings };
	await assert.rejects(mountFor("archil", { env: { COMPUTER_ARCHIL_DISK: MOUNT.disk } }), (error) => /COMPUTER_ARCHIL_REGION/.test(error.message) && !error.message.includes(TOKEN));
	assert.equal(await mountFor("bind", { env }), undefined, "a Modal computer takes no bind");
	assert.equal(await mountFor("archil", { env: {} }), undefined, "no disk named: the case is skipped");
	await assert.rejects(mountFor("archil", { env: { ...env, AGENTRUN_COMPUTER_LIVE_MODAL: undefined }, archil: { objects: fakeObjects() } }), /AGENTRUN_COMPUTER_LIVE_MODAL/);
	const objects = fakeObjects();
	const folder = await mountFor("archil", { env, archil: { objects } });
	assert.deepEqual({ ...folder.mount, folder: undefined }, { ...MOUNT, folder: undefined });
	assert.match(folder.mount.folder, /^agents\/conformance\/runs\/[A-Za-z0-9][A-Za-z0-9_-]*\/work$/);
	await folder.write("a.txt", Buffer.from("outside\n"));
	assert.equal(Buffer.from(await folder.read("a.txt")).toString("utf8"), "outside\n");
	await folder.close();
	assert.equal(objects.objects.size, 0);
	noToken(objects.calls, "the object API's calls");
});

// --- the token, the server, the environment ---

/** The names a host may hold a production token under, with values that must never be used. */
const PROD_TOKEN = { MODAL_TOKEN_ID: "prod-id-must-not-be-used", MODAL_TOKEN_SECRET: "prod-token-must-not-be-used" };
const DEV_TOKEN = { COMPUTER_MODAL_TOKEN_ID: "fake-dev-id", COMPUTER_MODAL_TOKEN_SECRET: "fake-dev-secret" };
const MODAL_SETTINGS = { AGENTRUN_COMPUTER_LIVE_MODAL: "1", COMPUTER_MODAL_APP: APP };
/** A Modal token passed as options, as serve passes its own MODAL_TOKEN_ID and MODAL_TOKEN_SECRET. */
const TOKEN_OPTIONS = { tokenId: "fake-test-key", tokenSecret: "fake-test-key" };
const builds = [];
/** The module's options a unit test adds: the stand-in daemon, and a drifted build that runs no Go. */
const MODULE_TEST = {
	daemonPath: DAEMON_PATH,
	buildDaemon: async (version) => {
		builds.push(version);
		return DAEMON_PATH;
	},
};

/**
 * A stand-in for the SDK's ModalClient constructor: it records the params it is given, and the MODAL_SERVER_URL its
 * getProfile would read at that moment (modal-client@64880502:js/src/config.ts:140-143), and answers with a recorder.
 */
function fakeClient(rec = recorder()) {
	const made = [];
	const servers = [];
	function ModalClient(params) {
		made.push(params);
		servers.push(process.env.MODAL_SERVER_URL);
		return rec.sdk;
	}
	return { ModalClient, made, servers, rec };
}

test("no real Modal client: the provider and the conformance module import nothing from the SDK at load, and the module reads only its own names", async () => {
	for (const file of ["../dist/modal.js", "../dist/conformance/modal.js"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(source, /^import[^\n]*["']modal["']/m, `${file} has no static import of modal`);
	}
	const source = readFileSync(new URL("../dist/modal.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\bconsole\.|process\.(stdout|stderr)/, "the provider writes nowhere but its results");
	assert.doesNotMatch(source, /COMPUTER_MODAL_|process\.env\.MODAL_TOKEN/, "the provider reads no token and names no setting: the conformance module reads those");
	const module = await import("../dist/conformance/modal.js");
	for (const name of ["createProvider", "createDriftedProvider", "createHost", "sweepScope", "mountFor"]) assert.equal(typeof module[name], "function", name);
	assert.deepEqual(module.MODAL_ENV, {
		live: "AGENTRUN_COMPUTER_LIVE_MODAL",
		tokenId: "COMPUTER_MODAL_TOKEN_ID",
		tokenSecret: "COMPUTER_MODAL_TOKEN_SECRET",
		app: "COMPUTER_MODAL_APP",
		serverUrl: "COMPUTER_MODAL_SERVER_URL",
	});
	assert.equal(module.CONFORMANCE_MAX_LIFETIME_MS, 30 * 60_000);
	assert.equal(modal.modalCommands, undefined, "the scripts are the adapter's");
	assert.equal(modal.untilFinished, undefined, "the adapter waits for gone");
});

test("the conformance module refuses MODAL_TOKEN_ID and MODAL_TOKEN_SECRET: it names the COMPUTER_MODAL_ token it needs", async () => {
	const { createProvider, createDriftedProvider, createHost } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider, createHost]) {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(make({ env: { ...MODAL_SETTINGS, ...PROD_TOKEN }, ModalClient, ...MODULE_TEST }), (error) => {
			assert.match(error.message, /needs COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET/);
			assert.match(error.message, /never MODAL_TOKEN_ID or MODAL_TOKEN_SECRET/);
			assert.doesNotMatch(error.message, /prod-(id|token)-must-not-be-used/);
			return true;
		});
		assert.deepEqual(made, [], "no client is made without the COMPUTER_MODAL_ token");
	}
});

test("the conformance module passes the COMPUTER_MODAL_ token to the client explicitly, so an ambient MODAL_TOKEN_ cannot win; the sweep's host needs no live switch and calls nothing", async () => {
	const { createProvider, createDriftedProvider, createHost } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const { ModalClient, made } = fakeClient();
		const provider = await make({ env: { ...MODAL_SETTINGS, ...PROD_TOKEN, ...DEV_TOKEN }, ModalClient, ...MODULE_TEST });
		assert.equal(provider.id, "modal");
		assert.deepEqual(made, [{ tokenId: "fake-dev-id", tokenSecret: "fake-dev-secret" }]);
	}
	const { ModalClient, made, rec } = fakeClient();
	const host = await createHost({ env: { ...DEV_TOKEN, COMPUTER_MODAL_APP: APP }, ModalClient });
	assert.equal(host.id, "modal");
	assert.deepEqual(made, [{ tokenId: "fake-dev-id", tokenSecret: "fake-dev-secret" }]);
	assert.deepEqual(rec.calls, [], "the host calls nothing until the sweep does");
});

test("the live Modal suite skips when only MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are set", () => {
	const live = new URL("./modal/conformance.modal.test.mjs", import.meta.url).pathname;
	const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", live], {
		env: { PATH: process.env.PATH, AGENTRUN_COMPUTER_LIVE_MODAL: "1", ...PROD_TOKEN },
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /# SKIP .*COMPUTER_MODAL_TOKEN_ID and COMPUTER_MODAL_TOKEN_SECRET/);
	assert.match(run.stdout, /^# fail 0$/m);
	assert.match(run.stdout, /^# pass 0$/m);
});

test("the conformance module pins the client's server: an ambient MODAL_PROFILE or MODAL_CONFIG_PATH cannot redirect the key", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	const profiles = mkdtempSync(join(tmpdir(), "modal-profile-"));
	const toml = join(profiles, "modal.toml");
	writeFileSync(toml, '[prod]\nactive = true\nserver_url = "https://prod.example.invalid:443"\ntoken_id = "prod-id-must-not-be-used"\n');
	try {
		await withProcessEnv({ MODAL_PROFILE: "prod", MODAL_CONFIG_PATH: toml }, async () => {
			for (const make of [createProvider, createDriftedProvider]) {
				for (const [chosen, server] of [
					[{}, "https://api.modal.com:443"],
					[{ COMPUTER_MODAL_SERVER_URL: "https://dev.example.invalid:443" }, "https://dev.example.invalid:443"],
				]) {
					const { ModalClient, made, servers } = fakeClient();
					await make({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN, MODAL_PROFILE: "prod", MODAL_CONFIG_PATH: toml, ...chosen }, ModalClient, ...MODULE_TEST });
					assert.deepEqual(made, [{ tokenId: "fake-dev-id", tokenSecret: "fake-dev-secret" }]);
					assert.deepEqual(servers, [server], "the client is made with the server the module chose");
					assert.equal(process.env.MODAL_SERVER_URL, undefined, "and process.env is put back after");
				}
			}
		});
	} finally {
		rmSync(profiles, { recursive: true });
	}
});

test("the conformance module refuses an ambient MODAL_SERVER_URL in words, before any client", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const { ModalClient, made } = fakeClient();
		const env = { ...MODAL_SETTINGS, ...DEV_TOKEN, MODAL_SERVER_URL: "https://prod.example.invalid:443" };
		await assert.rejects(make({ env, ModalClient, ...MODULE_TEST }), (error) => {
			assert.match(error.message, /MODAL_SERVER_URL is set/);
			assert.match(error.message, /COMPUTER_MODAL_SERVER_URL/);
			return true;
		});
		assert.deepEqual(made, [], "no client is made while MODAL_SERVER_URL is set");
	}
});

test("the provider's create() reads no environment: the token, the app and the server are options, and it keeps Modal's 24-hour cap", async () => {
	assert.equal(modal.ENV, undefined, "no ENV of names");
	assert.equal(modal.fromEnv, undefined, "no fromEnv");
	const conformance = await import("../dist/conformance/modal.js");
	const refused = fakeClient();
	await assert.rejects(conformance.createProvider({ env: { ...DEV_TOKEN, COMPUTER_MODAL_APP: APP }, ModalClient: refused.ModalClient, ...MODULE_TEST }), /set AGENTRUN_COMPUTER_LIVE_MODAL=1/);
	assert.deepEqual(refused.made, [], "the conformance module makes no client without its live switch");
	await withProcessEnv({ ...PROD_TOKEN, ...DEV_TOKEN, COMPUTER_MODAL_APP: "elsewhere", AGENTRUN_BOX_APP: "elsewhere", COMPUTER_MODAL_SERVER_URL: "https://prod.example.invalid:443" }, async () => {
		const { ModalClient, made, servers } = fakeClient();
		const provider = await modal.create({ ...TOKEN_OPTIONS, app: APP, ModalClient, daemonPath: DAEMON_PATH });
		assert.equal(provider.id, "modal");
		assert.equal(provider.capabilities().maxLifetimeMs, DAY_MS);
		assert.deepEqual(made, [TOKEN_OPTIONS], "the token passed in, never one of the environment");
		assert.deepEqual(servers, ["https://api.modal.com:443"], "the SDK's default server, not COMPUTER_MODAL_SERVER_URL");
		const chosen = fakeClient();
		await modal.create({ ...TOKEN_OPTIONS, app: APP, serverUrl: "https://dev.example.invalid:443", ModalClient: chosen.ModalClient, daemonPath: DAEMON_PATH });
		assert.deepEqual(chosen.servers, ["https://dev.example.invalid:443"], "options.serverUrl is the server");
	});
});

test("the conformance module reads COMPUTER_MODAL_APP and passes it as options.app, and refuses without it in words naming it", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const rec = recorder();
		await withProcessEnv({ AGENTRUN_BOX_APP: "elsewhere" }, async () => {
			const provider = await make({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: fakeClient(rec).ModalClient, ...MODULE_TEST });
			assert.equal((await provider.list({})).ok, true);
		});
		assert.deepEqual(rec.calls.find(([name]) => name === "apps.fromName").slice(0, 2), ["apps.fromName", APP]);
		const { ModalClient, made } = fakeClient();
		await assert.rejects(make({ env: { AGENTRUN_COMPUTER_LIVE_MODAL: "1", ...DEV_TOKEN }, ModalClient, ...MODULE_TEST }), /COMPUTER_MODAL_APP/);
		assert.deepEqual(made, []);
	}
});

test("the provider's create() refuses without options.app in words naming the option, before any client: COMPUTER_MODAL_APP or AGENTRUN_BOX_APP in the environment is never read", async () => {
	await withProcessEnv({ COMPUTER_MODAL_APP: APP, AGENTRUN_BOX_APP: APP }, async () => {
		for (const app of [undefined, ""]) {
			const { ModalClient, made } = fakeClient();
			await assert.rejects(modal.create({ ...TOKEN_OPTIONS, ...(app === undefined ? {} : { app }), ModalClient, daemonPath: DAEMON_PATH }), (error) => {
				assert.match(error.message, /options\.app/);
				assert.doesNotMatch(error.message, /COMPUTER_MODAL_APP|AGENTRUN_BOX_APP/);
				return true;
			});
			assert.deepEqual(made, [], "no client is made without the app");
		}
	});
	await withProcessEnv({ ...PROD_TOKEN, ...DEV_TOKEN }, async () => {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(modal.create({ app: APP, ModalClient, daemonPath: DAEMON_PATH }), (error) => {
			assert.match(error.message, /options\.tokenId and options\.tokenSecret/);
			assert.doesNotMatch(error.message, /prod-(id|token)-must-not-be-used|fake-dev-(id|secret)/);
			return true;
		});
		assert.deepEqual(made, []);
	});
});

test("the provider refuses an ambient MODAL_SERVER_URL in process.env, the one variable it reads, and makes no client", async () => {
	await withProcessEnv({ MODAL_SERVER_URL: "https://prod.example.invalid:443" }, async () => {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(modal.create({ ...TOKEN_OPTIONS, app: APP, ModalClient, daemonPath: DAEMON_PATH }), (error) => {
			assert.match(error.message, /MODAL_SERVER_URL is set/);
			assert.match(error.message, /options\.serverUrl/);
			return true;
		});
		assert.deepEqual(made, []);
		assert.equal(process.env.MODAL_SERVER_URL, "https://prod.example.invalid:443", "and leaves it as it was");
	});
});

test("client constructions run one at a time: each sees only its own MODAL_SERVER_URL, and process.env is put back after each, a failed one too", async () => {
	const { modalClient } = modal;
	const servers = ["https://one.example.invalid:443", "https://two.example.invalid:443", "https://three.example.invalid:443"];
	const seen = [];
	let inside = 0;
	function ModalClient(params) {
		inside += 1;
		seen.push({ server: process.env.MODAL_SERVER_URL, inside, tokenId: params.tokenId });
		inside -= 1;
		if (process.env.MODAL_SERVER_URL === servers[1]) throw new Error("the SDK failed");
		return recorder().sdk;
	}
	const before = process.env.MODAL_SERVER_URL;
	await withProcessEnv({ MODAL_SERVER_URL: "" }, async () => {
		const made = servers.map((serverUrl) => modalClient({ ...TOKEN_OPTIONS, serverUrl, ModalClient }));
		assert.equal(process.env.MODAL_SERVER_URL, "", "nothing is set before a construction's turn");
		const settled = await Promise.allSettled(made);
		assert.deepEqual(settled.map((s) => s.status), ["fulfilled", "rejected", "fulfilled"]);
		assert.match(settled[1].reason.message, /the SDK failed/);
		assert.deepEqual(seen.map((s) => s.server), servers, "each construction saw its own server, in turn");
		assert.ok(seen.every((s) => s.inside === 1), "never two at once");
		assert.equal(process.env.MODAL_SERVER_URL, "", "the empty value it held is put back");
	});
	assert.equal(process.env.MODAL_SERVER_URL, before);
	assert.ok(await modalClient({ ...TOKEN_OPTIONS, ModalClient }), "a failed construction leaves the turn free for the next");
	assert.equal(seen.at(-1).server, "https://api.modal.com:443");
	assert.equal(process.env.MODAL_SERVER_URL, before, "and unset again after it");
});

test("a token Modal refuses is denied on every call, and Settings' test says unauthorized, the token never in the words", async () => {
	const { provider, rec } = setup({}, { refuse: true });
	const ref = { id: "sb-0000000000000000000001", name: "computer-0123456789ab" };
	assert.equal((await create(provider)).error?.code, "denied", "the listing by name the create starts with");
	assert.equal((await provider.list({})).error?.code, "denied");
	const tested = await provider.testConnection();
	assert.equal(tested.error?.code, "unauthorized");
	assert.doesNotMatch(tested.error.message, /fake-test-key/);
	assert.equal((await provider.release(ref, "delete")).error?.code, "denied");
	assert.equal((await provider.connect(ref)).error?.code, "denied");
	assert.ok(!rec.names().includes("sandboxes.create"), "nothing was made");
});

test("the CLI resolves --provider modal through the registry to the conformance module, which refuses without its live switch", async () => {
	const { main } = await import("../dist/conformance/cli.js");
	let err = "";
	const stderr = { write: (text, done) => ((err += text), done?.(), true) };
	await withProcessEnv({ AGENTRUN_COMPUTER_LIVE_MODAL: undefined }, async () => {
		assert.equal(await main(["--provider", "modal"], { stdout: stderr, stderr }), 1, err);
	});
	assert.match(err, /set AGENTRUN_COMPUTER_LIVE_MODAL=1/);
});

test("the conformance module caps every computer's lifetime at 30 minutes, refused longer in words before any SDK call, Modal's timeout the lifetime", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const rec = recorder();
		const provider = await make({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: fakeClient(rec).ModalClient, ...MODULE_TEST });
		assert.deepEqual(provider.check({ ...SPEC, lifetimeMs: 30 * 60_000 }), []);
		const refusals = provider.check({ ...SPEC, lifetimeMs: 30 * 60_000 + 1000 });
		assert.deepEqual(refusals.map((r) => r.field), ["lifetimeMs"]);
		assert.match(refusals[0].message, /at most 30 min \(1800000 ms\)/);
		const refused = await create(provider, { ...SPEC, lifetimeMs: 2 * 60 * 60_000 });
		assert.equal(refused.error?.code, "refused");
		assert.deepEqual(rec.calls, []);
		await create(provider, { ...SPEC, lifetimeMs: 30 * 60_000 });
		assert.equal(rec.params().timeoutMs, 30 * 60_000);
	}
});

test("the drifted provider uploads a daemon built as <version>-drift", async () => {
	const { createDriftedProvider } = await import("../dist/conformance/modal.js");
	builds.length = 0;
	const drifted = await createDriftedProvider({ env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, ModalClient: fakeClient().ModalClient, ...MODULE_TEST });
	assert.deepEqual(builds, [`${VERSION}-drift`]);
	assert.equal(drifted.id, "modal");
});

// The loopback block: whatever Modal runs inside a sandbox, the daemon's programs get a network of their own (init
// --own-network) and run as 2510:2510. No listener of Modal's inside is documented, so no port is declared.

test("the loopback block: network none only, no agent port declared, open refused in words", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.capabilities().network, ["none"]);
	assert.deepEqual(provider.capabilities().vendorAgentPorts, []);
	const refusals = provider.check({ ...SPEC, network: "open" });
	assert.deepEqual(refusals.map((r) => r.field), ["network"]);
	assert.match(refusals[0].message, /network "none" only: its programs run in a network of their own/);
	assert.deepEqual(rec.calls, []);
});
