// ModalProvider without a vendor fake: what Modal's own host decides (its capabilities, its check, the 512 bytes of
// tags, what sandboxes.create is handed, the token and the server on every client, the environment it reads and
// refuses, the conformance module's names), each read from options or from what the SDK slice is handed. The adapter's
// lifecycle is tested once, against its one fake host (hosted-provider.test.mjs); Modal's own lifecycle is proven live
// (test/modal). The SDK slice here only records what it is given and answers nothing that makes a sandbox: no sandbox
// exists, no Modal client is constructed unless a test says so, and nothing reaches the network. One test, the desktop
// over dial, gives the slice sandboxes it keeps, each booted from its env (fake-dial-host.mjs bootDial).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachHub, checkLifetime, computerNameFor, kindRefusals, MemoryMachineTokens, mountsOf, recordedMount, sweep } from "../dist/index.js";
import { fakeObjects } from "./fake-archil.mjs";
import { bootDial, desktopOverDial, dialServer } from "./fake-dial-host.mjs";
import { refusesHttp } from "./https-refusal.mjs";

const modal = await import("../dist/modal.js");
const { MODAL } = await import("../dist/descriptors/modal.js");
/** A sandbox's tags as the labels they pack (Modal keeps its tags packed, facts.labels.packed). */
const { unpackLabels: labelsIn } = await import("../dist/hosted/values.js");
const { ModalProvider } = modal;

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: "none" };
const APP = "computers";
const COMPUTER = "agentrun.computer";
const NAME = "agentrun.computer.name";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The box image the release publishes, tagged with box/recipe.mjs's hash: the Dockerfile, then install.sh and the helper it copies, 12 hex. */
const BOX_IMAGE = `ghcr.io/parcha-ai/agentrun-box:${createHash("sha256")
	.update(Buffer.concat(["Dockerfile", "install.sh", "agentrun-archil"].map((name) => readFileSync(new URL(`../box/${name}`, import.meta.url)))))
	.digest("hex")
	.slice(0, 12)}`;
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
function recorder({ refuse = false, appMissing = false } = {}) {
	const calls = [];
	let made = !appMissing;
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
		apps: {
			fromName: record("apps.fromName", async (name, { createIfMissing } = {}) => {
				if (!made && !createIfMissing) throw Object.assign(new Error(`App '${name}' not found`), { name: "NotFoundError" });
				made = true;
				return { appId: `ap-${name}` };
			}),
		},
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

test("capabilities: a linux VM whose lifetime Modal enforces up to 24 hours, init its main process, network none, open and a list with no vendor read-back, a uid, no agent port, GPUs on gVisor", () => {
	const { provider, rec } = setup();
	assert.equal(provider.id, "modal");
	assert.equal(provider.version, VERSION);
	assert.deepEqual(provider.capabilities(), {
		kind: "linux",
		lifetime: "vendor",
		network: ["none", "open", "allow"],
		allow: { domains: { max: 256, ports: [80, 443] }, cidrs: { max: 256, ports: [80, 443] }, mixed: true },
		networkReadBack: false,
		isolation: "vm",
		os: "linux",
		daemon: "pid1",
		groups: ["exec", "files", "processes"],
		maxLifetimeMs: DAY_MS,
		user: ["uid"],
		release: ["delete"],
		mount: ["archil", "sync"],
		vendorAgentPorts: [],
		gpu: {
			types: ["T4", "L4", "A10", "L40S", "A100", "A100-40GB", "A100-80GB", "RTX-PRO-6000", "H100", "H200", "B200", "B300"],
			max: 8,
			isolation: "gvisor",
			preemptible: true,
			mounts: ["sync"],
			unmounted: { why: "Archil's FUSE mount isn't proven on Modal's gVisor runtime (#2279)", yet: true },
			fence: "userns-netns",
		},
	});
	assert.deepEqual(MODAL.capabilities[0].gpu, provider.capabilities().gpu, "the static configuration declares the same GPUs");
	assert.deepEqual(provider.capabilities().mount, ["archil", "sync"]);
	assert.deepEqual(kindRefusals(provider.capabilities()), []);
	assert.equal(provider.extend, undefined, "no extend(): Modal's timeout cannot move");
	assert.equal(provider.stream, undefined, "no stream()");
	assert.deepEqual(rec.calls, []);
});

test("Modal's descriptor says it prepares its image and names no default image: every Modal sandbox starts from the box image", async () => {
	assert.equal(MODAL.prepareImage, true);
	assert.equal(MODAL.defaultImage, undefined, "every Modal computer starts from the image prepareImage answers");
	assert.equal("MODAL_DEFAULT_IMAGE" in (await import("../dist/descriptors/index.js")), false);
	assert.equal("MODAL_DEFAULT_IMAGE" in (await import("../dist/index.js")), false);
});

test("prepareImage answers the box image's public registry tag with no SDK call and no wait told (Modal pulls it at create), and create starts from it by images.fromRegistry", async () => {
	const { provider, rec } = setup();
	const waits = [];
	assert.deepEqual(await provider.prepareImage({ onWait: (...said) => waits.push(said) }), { ok: true, value: BOX_IMAGE });
	assert.deepEqual(await provider.prepareImage(), { ok: true, value: BOX_IMAGE }, "no context: the same tag");
	assert.deepEqual(rec.calls, [], "no Modal call: nothing to pull ahead of the first create");
	assert.deepEqual(waits, [], "never told a pull: the claim waits on create, and a warm workspace waits on nothing");
	await create(provider, { ...SPEC, image: BOX_IMAGE });
	assert.deepEqual(rec.calls.find(([name]) => name.startsWith("images."))?.slice(0, 2), ["images.fromRegistry", BOX_IMAGE]);
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
	for (const network of ["open", { allow: ["8.8.8.0/24"] }]) assert.deepEqual(refused({ ...SPEC, network }), [], `network ${JSON.stringify(network)}`);
	assert.deepEqual(refused({ ...SPEC, network: "wifi" }), ["network"]);
	assert.match(words({ ...SPEC, network: "wifi" }, "network"), /network is required: none, open or a list/);
	for (const cpus of [0, -1, 0.1, "2", Number.NaN]) assert.deepEqual(refused({ ...SPEC, cpus }), ["cpus"], `cpus ${String(cpus)}`);
	assert.match(words({ ...SPEC, cpus: 0.1 }, "cpus"), /Modal counts physical cores, 2 CPUs each/);
	for (const memoryMb of [0, 1.5, "512"]) assert.deepEqual(refused({ ...SPEC, memoryMb }), ["memoryMb"], `memoryMb ${String(memoryMb)}`);
	assert.deepEqual(refused({ ...SPEC, pids: 64 }), ["pids"]);
	// A Modal computer works in its home: the daemon's working directory is read back as /work.
	assert.deepEqual(refused({ ...SPEC, workdir: "/opt/app" }), ["workdir"]);
	assert.match(words({ ...SPEC, workdir: "/opt/app" }, "workdir"), /works in \/work, its home/);
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

test("Modal keeps its tags packed: a computer with more labels than Modal's 10 tags is made in two, read back exactly; labels that pack past 512 bytes are refused in words before any SDK call", async () => {
	const eleven = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => [`l${n}`, "v"]));
	const { provider, rec } = setup();
	assert.deepEqual(provider.check({ ...SPEC, labels: eleven }), [], "eleven of the caller's labels, beside the adapter's, fit packed");
	assert.deepEqual(rec.calls, [], "check made no SDK call");
	await create(provider, { ...SPEC, labels: eleven });
	const { tags } = rec.params();
	assert.deepEqual(Object.keys(tags), ["agentrun", "agentrun-0"], "two tags go to Modal");
	assert.ok(bytesOf(tags) <= 512, `${bytesOf(tags)} bytes of tags`);
	assert.deepEqual(Object.fromEntries(Object.entries(labelsIn(tags)).filter(([key]) => key.startsWith("l"))), eleven, "read back exactly");
	// Digests deflate to no less than half their hex: nine of 128 hex digits pack past Modal's 512 bytes.
	const digests = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`n${n}`, createHash("sha512").update(`n${n}`).digest("hex")]));
	const tight = setup();
	const refusals = tight.provider.check({ ...SPEC, labels: digests });
	assert.equal(refusals.length, 1, JSON.stringify(refusals));
	assert.equal(refusals[0].field, "labels");
	assert.match(refusals[0].message, /^a Modal computer keeps its labels packed, and its labels pack into 2 labels of \d+ bytes in all, past the 10 labels and 512 bytes it keeps: give a shorter image, mount folder or labels$/);
	const made = await create(tight.provider, { ...SPEC, labels: digests });
	assert.equal(made.error?.code, "refused");
	assert.equal(made.error.message, `labels: ${refusals[0].message}`, "create's words are check's");
	assert.deepEqual(tight.rec.calls, [], "create refused before any SDK call: no app lookup, no listing, no sandboxes.create");
});

test("a caller's label under the packed map's keys (agentrun, agentrun-<n>) is refused at check() and at create, in words naming them, before any SDK call: it could pass for a packed map where tags are read as given", async () => {
	const { provider, rec } = setup();
	for (const key of ["agentrun", "agentrun-0", "agentrun-3"]) {
		const spec = { ...SPEC, labels: { [key]: "pforged" } };
		assert.deepEqual(provider.check(spec).map((r) => r.field), ["labels"], key);
		const created = await create(provider, spec);
		assert.equal(created.error?.code, "refused", key);
		assert.match(created.error.message, new RegExp(`the label ${key} is reserved: agentrun and agentrun-<n>`), key);
	}
	assert.deepEqual(rec.names(), [], "no SDK call");
});

test("the janitor does not sweep Modal computers: Modal ends them at their lifetime", async () => {
	const { provider, rec } = setup();
	const swept = await sweep(provider);
	assert.equal(swept.error?.code, "refused");
	assert.deepEqual(rec.calls, []);
});

// --- what sandboxes.create is handed ---

test("a listing before any computer makes no app: it looks the app up with createIfMissing false and finds none; create alone makes it", async () => {
	const { provider, rec } = setup({}, { appMissing: true });
	assert.deepEqual(await provider.list({}), { ok: true, value: [] }, "an app not made yet holds no computer");
	assert.match((await provider.testConnection()).value?.detail ?? "", /^Modal answered: 0 computers of this provider$/, "Settings' test is the one shared listing");
	assert.deepEqual(rec.names(), ["apps.fromName", "apps.fromName"], "two lookups, no sandboxes.list");
	assert.ok(rec.calls.every(([, , options]) => options?.createIfMissing === false), "neither made the app");
	assert.equal((await create(provider)).error?.code, "invalid", "a create Modal refused made nothing");
	const lookups = rec.calls.filter(([name]) => name === "apps.fromName").map(([, , options]) => options.createIfMissing);
	// The create's listing by name asks twice, packed and as given (a sandbox made before Modal's tags were packed).
	assert.deepEqual(lookups, [false, false, false, false, true], "the create's listing by name finds no app either; the create makes it");
});

test("create asks Modal for one VM sandbox in the app: the entrypoint as its command, init --own-network as 2510:2510, the lifetime as its timeout in whole seconds, Modal's small request under the spec's limits, no network, the labels as tags", async () => {
	const { provider, rec } = setup();
	const result = await create(provider, { ...SPEC, lifetimeMs: 600_500, labels: { team: "a" } });
	assert.equal(result.error?.code, "invalid", "a create Modal refused made nothing");
	assert.deepEqual(rec.names().slice(0, 2), ["apps.fromName", "sandboxes.list"], "the listing by the request's name comes first");
	const [[, packed], [, given]] = rec.calls.filter(([name]) => name === "sandboxes.list");
	assert.deepEqual(Object.keys(packed.tags), ["agentrun"], "the packed name first");
	assert.deepEqual(Object.keys(given.tags).sort(), [COMPUTER, NAME], "then the labels as given");
	assert.deepEqual(rec.calls.find(([name]) => name === "apps.fromName").slice(1), [APP, { createIfMissing: false }], "the listing looks the app up without making it, and keeps the one it found");
	assert.equal(rec.names().filter((name) => name === "apps.fromName").length, 1);
	const tags = labelsIn(rec.params().tags);
	assert.deepEqual(Object.keys(rec.params().tags), ["agentrun", "agentrun-0"], "the labels go to Modal packed");
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
	assert.equal(tags.team, "a");
	assert.equal(tags[COMPUTER], "1");
	assert.match(tags[NAME], /^computer-[0-9a-f]{12}$/);
	assert.equal(params.tags.agentrun, tags[NAME], "the packed name is the computer's name");
	// No max-deadline label: Modal has no extend, the label's one reader, so none of its 512 bytes go to it.
	assert.deepEqual(Object.keys(tags).sort(), ["agentrun.computer", "agentrun.computer.deadline", "agentrun.computer.image", "agentrun.computer.name", "team"]);
	assert.ok(init.includes("--max-deadline"), "init still holds the most its deadline may reach");
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

test("check(): an Archil spec takes network none or open, the run and epoch labels, the helper's shapes and the tool user, with no SDK call; no refusal holds the token", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.check(ARCHIL_SPEC), []);
	assert.deepEqual(provider.check({ ...ARCHIL_SPEC, network: "open" }), [], "open: the tools' proxy beside root's mount");
	assert.deepEqual(provider.check({ ...ARCHIL_SPEC, user: "2510:2510" }), [], "the tool user, named");
	const cases = [
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
	assert.equal(labelsIn(tags)["agentrun.mount"], JSON.stringify({ kind: "archil", disk: MOUNT.disk, region: MOUNT.region, agent: "a1" }));
	assert.equal(recordedMount(labelsIn(tags)).folder, MOUNT.folder, "read back as the adapter wrote it");
	noToken(rec.calls, "what the SDK was handed");
});

test("create under open or a list leaves Modal's network on (no blockNetwork) for init's egress proxy, gives init --network and the form, and records it in a tag; an Archil computer under open too", async () => {
	for (const [spec, form] of [
		[{ ...SPEC, network: "open" }, "open"],
		[{ ...SPEC, network: { allow: ["Example.com"] } }, "allow:example.com"],
		[{ ...ARCHIL_SPEC, network: "open" }, "open"],
	]) {
		const { provider, rec } = setup();
		await create(provider, spec);
		const { blockNetwork, command, tags } = rec.params();
		assert.equal(blockNetwork, undefined, form);
		assert.deepEqual(command.slice(-2), ["--network", form]);
		assert.equal(labelsIn(tags)["agentrun.computer.network"], form);
	}
});

test("Modal's 512 bytes of tags: qa36's Archil computer and one of the longest agent id on the box image fit packed; past the bound check() refuses in words, before any SDK call", async () => {
	const archilSpec = (agent, image) => ({ ...SPEC, image, labels: { "agentrun.run": RUN, "agentrun.epoch": "1" }, mount: { ...MOUNT, folder: `agents/${agent}/runs/${RUN}/work` } });
	for (const spec of [archilSpec("qa35e-modal-mwdsumo1", "registry.example/agentrun-archil:qa36"), archilSpec("a".repeat(128), BOX_IMAGE)]) {
		const { provider, rec } = setup();
		assert.deepEqual(provider.check(spec), []);
		await create(provider, spec);
		const { tags } = rec.params();
		assert.ok(bytesOf(tags) <= 512, `${bytesOf(tags)} bytes of tags`);
		assert.equal(recordedMount(labelsIn(tags)).folder, spec.mount.folder);
	}
	const { provider, rec } = setup();
	// A digest deflates to no less than half its hex: an image of four of them packs past 512 bytes.
	const digest = (n) => createHash("sha512").update(`d${n}`).digest("hex");
	const over = archilSpec("a".repeat(128), `registry.example/agentrun-archil:${digest(1)}${digest(2)}${digest(3)}${digest(4)}`.slice(0, 520));
	const refusals = provider.check(over);
	assert.equal(refusals.length, 1, JSON.stringify(refusals));
	assert.equal(refusals[0].field, "mount");
	assert.match(refusals[0].message, /^a Modal computer keeps its labels packed, and its labels pack into 2 labels of \d+ bytes in all, past the 10 labels and 512 bytes it keeps: give a shorter image, mount folder or labels$/);
	noToken(refusals, "the refusal of the tags' size");
	const created = await create(provider, over);
	assert.equal(created.error?.code, "refused");
	const long = { ...SPEC, labels: { a: `${digest(5)}${digest(6)}${digest(7)}${digest(8)}${digest(9)}` } };
	assert.deepEqual(provider.check(long).map((r) => r.field), ["labels"], "a computer with no mount: the labels are the field");
	assert.deepEqual(rec.calls, [], "no SDK call");
});

test("a hosted Modal computer with the server's labels (an Archil mount for the longest agent id, a network list, a run and its epoch, the deadlines) is made: its tags go to Modal packed within 10 tags and 512 bytes, and read back exactly", async () => {
	const { unpackLabels } = await import("../dist/hosted/values.js");
	const agent = "a".repeat(128);
	const spec = {
		...SPEC,
		image: BOX_IMAGE,
		network: { allow: ["api.anthropic.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.com"] },
		labels: { "agentrun.run": RUN, "agentrun.epoch": "1" },
		mount: { ...MOUNT, folder: `agents/${agent}/runs/${RUN}/work` },
	};
	const { provider, rec } = setup();
	assert.deepEqual(provider.check(spec), [], "check() takes the server's computer");
	await create(provider, spec);
	assert.ok(rec.names().includes("sandboxes.create"), "the create reaches Modal");
	const { tags } = rec.params();
	assert.ok(Object.keys(tags).length <= 10, `${Object.keys(tags).length} tags, past Modal's 10`);
	assert.ok(bytesOf(tags) <= 512, `${bytesOf(tags)} bytes of tags, past Modal's 512`);
	const labels = unpackLabels(tags);
	assert.ok(labels !== undefined, "the tags hold a packed map");
	assert.ok(Object.entries(labels).reduce((sum, [key, value]) => sum + key.length + value.length, 0) > 512, "as given, the labels pass Modal's 512 bytes");
	assert.equal(labels["agentrun.run"], RUN);
	assert.match(labels["agentrun.computer.network"], /^allow:.*registry\.npmjs\.org/);
	assert.equal(recordedMount(labels).folder, spec.mount.folder);
	noToken(tags, "the tags");
});

test("a sandbox made before Modal's tags were packed, its labels as tags, is still the adapter's: list finds it by a label and by its name, attach by its id reads it, a reap by its run's label ends it, and a create of its name finds it and makes none", async () => {
	const requestId = "req-modal-before";
	const name = computerNameFor(requestId);
	const before = { [COMPUTER]: "1", [NAME]: name, "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.image": SPEC.image, "agentrun.computer.network": "none", "agentrun.run": RUN, "agentrun.epoch": "1" };
	let finished = null;
	const calls = [];
	const sandbox = {
		sandboxId: "sb-before",
		poll: async () => finished,
		getTags: async () => ({ ...before }),
		terminate: async () => {
			calls.push(["terminate"]);
			finished = 0;
		},
		exec: async () => {
			calls.push(["exec"]);
			throw Object.assign(new Error("400: refused by the test"), { name: "InvalidError" });
		},
	};
	const sdk = {
		apps: { fromName: async (app) => ({ appId: `ap-${app}` }) },
		images: { fromRegistry: (tag) => ({ tag, dockerfileCommands: () => ({ tag }) }), fromId: async (id) => ({ id, dockerfileCommands: () => ({ id }) }) },
		sandboxes: {
			create: async () => {
				calls.push(["sandboxes.create"]);
				throw Object.assign(new Error("400: refused by the test"), { name: "InvalidError" });
			},
			fromId: async (id) => (id === sandbox.sandboxId ? sandbox : Promise.reject(Object.assign(new Error("Sandbox not found"), { name: "NotFoundError" }))),
			// Modal's list filters by tags: the sandbox's own, as they were stored.
			list: ({ tags }) => {
				calls.push(["sandboxes.list", tags]);
				const shown = finished === null && Object.entries(tags).every(([key, value]) => before[key] === value) ? [sandbox] : [];
				return { async *[Symbol.asyncIterator]() { yield* shown; } };
			},
		},
	};
	const provider = new ModalProvider({ sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const lists = () => calls.filter(([what]) => what === "sandboxes.list").map(([, tags]) => tags);

	const byName = await provider.list({ [NAME]: name });
	assert.deepEqual(byName.value?.map(({ ref }) => ref.id), ["sb-before"], "found by its name");
	assert.deepEqual(lists(), [{ agentrun: name }, { [NAME]: name, [COMPUTER]: "1" }], "asked by the packed name and by the labels as given");

	// attach by id: the read gives its labels, so it is the adapter's, and the attach goes on to connect (here refused).
	const attached = await provider.attach({ id: "sb-before" });
	assert.notEqual(attached.error?.code, "not_found", JSON.stringify(attached.error));

	// create of its name: the listing by the request's name finds it, so no sandbox is made.
	calls.length = 0;
	await provider.create(SPEC, { requestId });
	assert.ok(lists().some((tags) => tags[NAME] === name), "the create asked for the name's labels as given");
	assert.ok(!calls.some(([what]) => what === "sandboxes.create"), `the create made no sandbox: ${JSON.stringify(calls.map(([what]) => what))}`);

	// a reap: the run's computers by its label, each released.
	const byRun = await provider.list({ "agentrun.run": RUN });
	assert.deepEqual(byRun.value?.map(({ ref }) => ref), [{ id: "sb-before", name }], "found by its run's label");
	assert.equal(byRun.value[0].labels["agentrun.run"], RUN);
	const released = await provider.release(byRun.value[0].ref, "delete");
	assert.equal(released.ok, true, JSON.stringify(released));
	assert.ok(calls.some(([what]) => what === "terminate"), "the reap ended it");
});

/**
 * A Modal whose sandboxes are listed by their stored tags: a create gives a packed sandbox, and an older server's create
 * of the same request makes a sandbox with its labels as tags, listed from the moment the new one is made. Each
 * sandbox's id is the one given; Modal answers no createdAt, so the lower id is the older.
 */
function upgradeModal({ rawId, packedId, name }) {
	const calls = [];
	const sandboxes = new Map();
	const sandbox = (sandboxId, tags) => {
		const box = {
			sandboxId,
			tags,
			finished: null,
			poll: async () => box.finished,
			getTags: async () => ({ ...tags }),
			terminate: async () => {
				calls.push(["terminate", sandboxId]);
				box.finished = 0;
			},
			exec: async () => {
				calls.push(["exec", sandboxId]);
				throw Object.assign(new Error("400: refused by the test"), { name: "InvalidError" });
			},
		};
		return box;
	};
	const raw = sandbox(rawId, { [COMPUTER]: "1", [NAME]: name, "agentrun.computer.deadline": new Date(Date.now() + 600_000).toISOString(), "agentrun.computer.image": SPEC.image, "agentrun.computer.network": "none" });
	const sdk = {
		apps: { fromName: async (app) => ({ appId: `ap-${app}` }) },
		images: { fromRegistry: (tag) => ({ tag, dockerfileCommands: () => ({ tag }) }), fromId: async (id) => ({ id, dockerfileCommands: () => ({ id }) }) },
		sandboxes: {
			create: async (_app, _image, params) => {
				calls.push(["sandboxes.create"]);
				sandboxes.set(raw.sandboxId, raw);
				const made = sandbox(packedId, { ...params.tags });
				sandboxes.set(packedId, made);
				return made;
			},
			fromId: async (id) => sandboxes.get(id) ?? Promise.reject(Object.assign(new Error("Sandbox not found"), { name: "NotFoundError" })),
			list: ({ tags }) => {
				calls.push(["sandboxes.list", tags]);
				const shown = [...sandboxes.values()].filter((box) => box.finished === null && Object.entries(tags).every(([key, value]) => box.tags[key] === value));
				return { async *[Symbol.asyncIterator]() { yield* shown; } };
			},
		},
	};
	return { sdk, calls, raw, sandboxes };
}

test("across the upgrade, a request's raw sandbox (an older server's) and its packed one (this server's) converge on one: the oldest by Modal's id is kept and the other deleted, whichever form each is", async () => {
	// The raw one is older: this server's packed sandbox is deleted and the create goes on with the raw one.
	{
		const requestId = "req-modal-twin-raw";
		const name = computerNameFor(requestId);
		const modal = upgradeModal({ rawId: "sb-0-raw", packedId: "sb-1-packed", name });
		const provider = new ModalProvider({ sdk: modal.sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		const created = await provider.create(SPEC, { requestId });
		const terminated = modal.calls.filter(([what]) => what === "terminate").map(([, id]) => id);
		assert.equal(modal.calls.filter(([what]) => what === "sandboxes.create").length, 1, "one sandbox made by this server");
		assert.deepEqual(terminated, ["sb-1-packed"], `the packed one, the newer, is deleted and the raw one kept: ${JSON.stringify(created.error)}`);
		assert.ok(modal.calls.some(([what, id]) => what === "exec" && id === "sb-0-raw"), "the create goes on with the raw one, the one kept");
		assert.ok(!modal.calls.some(([what, id]) => what === "exec" && id === "sb-1-packed"), "nothing runs in the deleted one");
		assert.doesNotMatch(created.error?.message ?? "", /machines carry the name/, "never refused as two of one name");
	}
	// The packed one is older: the raw one is deleted before this server prepares its own.
	{
		const requestId = "req-modal-twin-packed";
		const name = computerNameFor(requestId);
		const modal = upgradeModal({ rawId: "sb-9-raw", packedId: "sb-1-packed", name });
		const provider = new ModalProvider({ sdk: modal.sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
		const created = await provider.create(SPEC, { requestId });
		const order = modal.calls.filter(([what]) => what === "terminate" || what === "exec").map(([what, id]) => `${what} ${id}`);
		assert.equal(modal.calls.filter(([what]) => what === "sandboxes.create").length, 1, "one sandbox made by this server");
		assert.equal(order[0], "terminate sb-9-raw", `the raw one, the newer, is deleted first: ${JSON.stringify(order)}`);
		assert.ok(order.includes("exec sb-1-packed"), "the create goes on with its own packed one, the one kept");
		assert.ok(!order.includes("exec sb-9-raw"), "nothing runs in the deleted one");
		assert.doesNotMatch(created.error?.message ?? "", /machines carry the name/, "never refused as two of one name");
	}
});

test('the Modal conformance module: mountFor("archil") gives a fresh run folder on the disk COMPUTER_ARCHIL_* name, read and written outside through the disk\'s object API', async () => {
	const { ARCHIL_ENV, MODAL_ENV, mountFor } = await import("../dist/conformance/modal.js");
	assert.deepEqual(Object.values(ARCHIL_ENV), ["COMPUTER_ARCHIL_DISK", "COMPUTER_ARCHIL_REGION", "COMPUTER_ARCHIL_TOKEN", "COMPUTER_ARCHIL_API_KEY", "COMPUTER_ARCHIL_S3_URL"]);
	assert.equal(Object.values(MODAL_ENV).some((name) => name.startsWith("COMPUTER_ARCHIL_")), false, "the provider's settings name no Archil setting");
	const settings = {
		COMPUTER_ARCHIL_DISK: MOUNT.disk,
		COMPUTER_ARCHIL_REGION: MOUNT.region,
		COMPUTER_ARCHIL_TOKEN: TOKEN,
		COMPUTER_ARCHIL_API_KEY: "fake-test-key",
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

test("a conformance run's mount cases fit Modal's 10 tags and 512 bytes: each computer as the runner makes it, the run's and the runner's labels, the claim, the case, the mount and the box image, the longest image a Modal recipe runs", async (t) => {
	const { conformanceImage, mountFor } = await import("../dist/conformance/modal.js");
	const { runConformance } = await import("../dist/conformance/index.js");
	// The box image: the run's image on dial, and the image that holds the Archil client, so an Archil run's --image.
	const image = conformanceImage({ env: { COMPUTER_MODAL_CONNECT: "dial" } });
	assert.equal(image, BOX_IMAGE);
	const env = {
		AGENTRUN_COMPUTER_LIVE_MODAL: "1",
		COMPUTER_ARCHIL_DISK: MOUNT.disk,
		COMPUTER_ARCHIL_REGION: MOUNT.region,
		COMPUTER_ARCHIL_TOKEN: TOKEN,
		COMPUTER_ARCHIL_API_KEY: "fake-test-key",
		COMPUTER_ARCHIL_S3_URL: "https://s3.green.us-east-1.aws.prod.archil.com",
	};
	const { provider, rec } = setup();
	const report = await runConformance(provider, {
		image,
		only: ["mount"],
		mountFor: (kind) => mountFor(kind, { env, archil: { objects: fakeObjects() } }),
		caseTimeoutMs: 10_000,
		cleanupTimeoutMs: 2_000,
	});
	// A case whose labels are past Modal's bounds is refused by the adapter itself (check, then create) before Modal is
	// called, so it never reaches sandboxes.create. That refusal is the bound this test guards, so it is read first.
	const overBudget = report.results.filter(({ reason }) => /a Modal computer keeps its labels packed/.test(reason ?? ""));
	assert.deepEqual(
		overBudget.map(({ id }) => id),
		[],
		`these mount cases' labels are past Modal's 10 tags or 512 bytes, and the adapter refused them:\n${overBudget.map(({ id, reason }) => `${id}: ${reason}`).join("\n").replaceAll(TOKEN, "[token]")}`,
	);
	// The tags of each create, as Modal is handed them: the recorder refuses every create, so each case ends at its first.
	// The mount cases carry the most of a run's labels (a claim's two and the mount's beside the case's), so they bound it.
	// The run's shared computer is made once too, for the hello the cases' exec and files needs are read from. It carries
	// no case label: it is the create named by its request, <runner>/shared (the runner's own label holds <runner>).
	const made = rec.calls.filter(([name]) => name === "sandboxes.create").map(([, , , params]) => params.tags);
	const given = (tags) => labelsIn(tags);
	const roleOf = (tags) => (given(tags)[NAME] === computerNameFor(`${given(tags)["agentrun.conformance.runner"]}/shared`) ? "the run's shared computer" : given(tags)["agentrun.conformance.case"]);
	const results = report.results.map(({ id, status, reason }) => `${id} ${status}: ${reason}`).join("\n");
	assert.deepEqual(
		made.map(roleOf).sort(),
		["mount-archil", "mount-archil-durable", "mount-archil-isolated-durable", "mount-archil-loop-tool-edit", "mount-archil-takeover-1", "mount-archil-token", "mount-sync-cap", "mount-sync-delete", "mount-sync-durable", "mount-sync-push", "the run's shared computer"],
		`every mount case Modal takes, and the run's shared computer, reached sandboxes.create:\n${results}`,
	);
	for (const tags of made) {
		const which = `${roleOf(tags)} (${JSON.stringify(tags).replaceAll(TOKEN, "[token]")})`;
		assert.ok(given(tags)["agentrun.conformance"] && given(tags)["agentrun.conformance.runner"], `${which}: the run's and the runner's labels`);
		assert.ok(Object.keys(tags).length <= 10, `${which}: ${Object.keys(tags).length} tags, past Modal's 10`);
		assert.ok(bytesOf(tags) <= 512, `${which}: ${bytesOf(tags)} bytes of tags, past Modal's 512`);
	}
	noToken(made, "the tags");
	// The worst: an Archil case, the longest case name, its mount's tag beside the box image's. The shared computer's tags
	// are a subset of every case's (no claim, case or mount label), so it is never the worst.
	const worst = made.reduce((most, tags) => (bytesOf(tags) > bytesOf(most) ? tags : most));
	assert.ok(roleOf(worst).startsWith("mount-"), `the worst is a mount case: ${roleOf(worst)}`);
	t.diagnostic(`the worst case's tags: ${Object.keys(worst).length} of Modal's 10, ${bytesOf(worst)} of its 512 bytes`);
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
		connect: "COMPUTER_MODAL_CONNECT",
		kind: "COMPUTER_MODAL_KIND",
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
	assert.equal(host.descriptor.id, "modal");
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
					[{}, "https://api.modal.com"],
					[{ COMPUTER_MODAL_SERVER_URL: "https://dev.example.invalid:8443" }, "https://dev.example.invalid:8443"],
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
		assert.deepEqual(servers, ["https://api.modal.com"], "the SDK's default server (its default port, 443, is inferred from https), not COMPUTER_MODAL_SERVER_URL");
		const chosen = fakeClient();
		await modal.create({ ...TOKEN_OPTIONS, app: APP, serverUrl: "https://dev.example.invalid:8443", ModalClient: chosen.ModalClient, daemonPath: DAEMON_PATH });
		assert.deepEqual(chosen.servers, ["https://dev.example.invalid:8443"], "options.serverUrl is the server");
		// An upper-case scheme reaches the client in lower case: nice-grpc reads the scheme case-sensitively (its
		// includes('https')), and would dial an upper-case one in the clear.
		const upper = fakeClient();
		await modal.create({ ...TOKEN_OPTIONS, app: APP, serverUrl: "HTTPS://API.MODAL.COM", ModalClient: upper.ModalClient, daemonPath: DAEMON_PATH });
		assert.deepEqual(upper.servers, ["https://api.modal.com"], "the scheme and host are lower-case");
	});
});

test("the server URL is https alone, loopback included, so the token never crosses in the clear: another is refused before any client is made", async () => {
	for (const serverUrl of ["http://api.modal.com:443", "http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost:8080", "grpc://api.modal.com:443"]) {
		const { ModalClient, made } = fakeClient();
		await assert.rejects(modal.create({ ...TOKEN_OPTIONS, app: APP, serverUrl, ModalClient, daemonPath: DAEMON_PATH }), refusesHttp("the Modal server URL (options.serverUrl)", serverUrl, TOKEN_OPTIONS.tokenId));
		assert.deepEqual(made, [], serverUrl);
	}
	const { ModalClient, made } = fakeClient();
	await assert.rejects(modal.create({ ...TOKEN_OPTIONS, app: APP, serverUrl: "//api.modal.com:443", ModalClient, daemonPath: DAEMON_PATH }), /the Modal server URL \(options\.serverUrl\) is not a URL/);
	assert.deepEqual(made, []);
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
			// The default named as the client gets it, with no :443 (https's own port).
			assert.match(error.message, /pass the server as options\.serverUrl if it is not https:\/\/api\.modal\.com$/);
			return true;
		});
		assert.deepEqual(made, []);
		assert.equal(process.env.MODAL_SERVER_URL, "https://prod.example.invalid:443", "and leaves it as it was");
	});
});

test("client constructions run one at a time: each sees only its own MODAL_SERVER_URL, and process.env is put back after each, a failed one too", async () => {
	const { modalClient } = modal;
	const servers = ["https://one.example.invalid:8443", "https://two.example.invalid:8443", "https://three.example.invalid:8443"];
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
	assert.equal(seen.at(-1).server, "https://api.modal.com");
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

/** A sandbox whose exec runs argv as a process on this machine, handed over as Modal's binary-mode ContainerProcess is. */
function processSandbox(execs) {
	return {
		sandboxId: "sb-here",
		exec: async (argv, params) => {
			execs.push({ argv, params });
			const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
			child.stdin.on("error", () => {});
			await once(child, "spawn");
			const code = new Promise((done) => child.on("close", (exit, signal) => done(exit ?? (signal ? 137 : -1))));
			return {
				stdout: child.stdout,
				stderr: child.stderr,
				stdin: { writeBytes: async (bytes) => void child.stdin.write(bytes), close: async () => void child.stdin.end() },
				wait: () => code,
			};
		},
	};
}

test("kill ends an exec and every process under it by its pid, as Modal has no kill for an exec, and its stderr is the process's own", async (t) => {
	if (!existsSync("/proc/self/stat")) return t.skip("no /proc here: the pid wrapper and its kill read /proc/<pid>/stat");
	const { PID_KILL, PID_WRAPPER } = await import("../dist/hosted/scripts.js");
	const execs = [];
	const rec = recorder();
	rec.sdk.sandboxes.fromId = async () => processSandbox(execs);
	const provider = new ModalProvider({ sdk: rec.sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	// A child that left the process group too: a kill of the group alone misses it.
	const proc = await provider.host.exec("sb-here", ["sh", "-c", "echo its own words >&2; setsid sleep 600 & echo $!; cat"], { timeoutMs: 2_000 });
	const err = [];
	const errRead = (async () => {
		for await (const chunk of proc.stderr) err.push(Buffer.from(chunk));
	})();
	const out = proc.stdout[Symbol.asyncIterator]();
	const sleeper = Number(Buffer.from((await out.next()).value).toString().trim());
	const dead = (pid) => {
		try {
			return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
		} catch {
			return true;
		}
	};
	t.after(() => spawnSync("kill", ["-KILL", String(sleeper)]));
	assert.equal(dead(sleeper), false);
	await proc.kill();
	assert.deepEqual(execs[0].argv, [...PID_WRAPPER, "sh", "-c", "echo its own words >&2; setsid sleep 600 & echo $!; cat"], "the process starts under the pid wrapper");
	assert.deepEqual(execs[1].argv.slice(0, 4), ["sh", "-c", PID_KILL, "sh"], "kill is an exec of the kill script");
	assert.equal(await proc.wait(), 137, "killed, while its stdin was still open");
	for (let at = 0; at < 100 && !dead(sleeper); at++) await new Promise((done) => setTimeout(done, 20));
	assert.equal(dead(sleeper), true, "the process under it is killed too");
	await errRead;
	assert.equal(Buffer.concat(err).toString(), "its own words\n", "the wrapper's line is taken off stderr");
});

// The loopback block: whatever Modal runs inside a sandbox, the daemon's programs get a network of their own (init
// --own-network) and run as 2510:2510. No listener of Modal's inside is documented, so no port is declared.

test("the loopback block: no agent port declared, open and a list taken through init's egress proxy alone", () => {
	const { provider, rec } = setup();
	assert.deepEqual(provider.capabilities().network, ["none", "open", "allow"]);
	assert.deepEqual(provider.capabilities().vendorAgentPorts, []);
	assert.deepEqual(provider.check({ ...SPEC, network: "open" }), []);
	assert.deepEqual(rec.calls, []);
});

/** A dial provider's server in tests: http on 127.0.0.1, which a dial provider takes in tests alone, its tokens and hub. */
const dialOf = () => ({ url: "http://127.0.0.1:8080", tokens: new MemoryMachineTokens(), hub: new AttachHub({ helloMs: 1_000 }) });

test("connect dial: the sandbox's command is agentrun-dial with the boot env as env (a Modal Secret), its network on, and the provider has no exec", async () => {
	const dial = dialOf();
	const { provider, rec } = setup({ connect: "dial", dial });
	assert.equal(provider.host.facts.connect, "dial");
	assert.equal(provider.host.exec, undefined, "no exec");
	assert.equal(provider.host.upload, undefined, "no upload");
	const result = await create(provider);
	assert.equal(result.error?.code, "invalid", "a create Modal refused made nothing");
	const params = rec.params();
	assert.deepEqual(params.command, ["/usr/local/bin/agentrun-dial"]);
	assert.deepEqual(Object.keys(params.env).sort(), ["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS"]);
	assert.equal(params.env.AGENTRUN_ATTACH_URL, "ws://127.0.0.1:8080/v2/computers/attach");
	assert.match(params.env.AGENTRUN_INIT_ARGS, /^--deadline \S+ --user 2510:2510 --own-network --max-deadline \S+$/);
	assert.equal(params.blockNetwork, undefined, "its root reaches the server; its tools' network none is init's");
	assert.equal(params.runtime, "vm");
	assert.equal(dial.tokens.check(params.env.AGENTRUN_ATTACH_TOKEN), undefined, "a create Modal refused has its token revoked");
	// Exec stays the default: the entrypoint as the command, and no env.
	const plain = setup();
	await create(plain.provider);
	assert.equal(plain.rec.params().env, undefined);
	assert.ok(plain.rec.params().command[2].startsWith(`${ENTRYPOINT_MARK}\n`));
	assert.equal(typeof plain.provider.host.exec, "function");
});

test("connect dial: init is agentrun-dial's child, no Archil mount (refused in words), GPUs still offered; no value but exec or dial", () => {
	const { provider, rec } = setup({ connect: "dial", dial: dialOf() });
	const caps = provider.capabilities();
	assert.equal(caps.daemon, "child");
	assert.deepEqual(caps.mount, ["sync"], "a synced folder alone: agentrun-dial makes /workspace");
	assert.equal(caps.gpu?.isolation, "gvisor");
	const refusals = provider.check({ ...SPEC, mount: { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work", token: "not-a-secret" } });
	assert.deepEqual(refusals.map(({ field }) => field), ["mount"]);
	assert.ok(refusals[0].message.includes(mountsOf(MODAL, () => false, true).unmounted.archil), refusals[0].message);
	assert.throws(() => setup({ connect: "ssh" }), /connect is how Modal reaches its machines, "exec" \(the default\) or "dial", not "ssh"/);
	assert.deepEqual(MODAL.settings, [
		{ name: "modalApp", option: "app", default: "agentrun" },
		{ name: "modalConnect", option: "connect" },
	]);
	assert.deepEqual(rec.calls, []);
});

test("kind desktop on connect dial: the desktop's groups, no GPU, the window manager, and DISPLAY beside the boot env, for init; on connect exec it is refused when made, in words", async () => {
	const dial = dialOf();
	const { provider, rec } = setup({ connect: "dial", dial, kind: "desktop" });
	const caps = provider.capabilities();
	assert.equal(caps.kind, "desktop");
	assert.deepEqual(caps.groups, ["exec", "files", "processes", "screen", "input.pointer", "input.keys", "apps"]);
	assert.equal(caps.gpu, undefined, "a desktop offers no GPU");
	assert.deepEqual(provider.check({ ...SPEC, gpu: { type: "T4", count: 1 } }).map(({ field }) => field), ["gpu"]);
	assert.equal(provider.host.facts.windowManager, true, "the box image has xfwm4");
	const result = await create(provider);
	assert.equal(result.error?.code, "invalid", "a create Modal refused made nothing");
	const { env } = rec.params();
	assert.deepEqual(Object.keys(env).sort(), ["AGENTRUN_ATTACH_TOKEN", "AGENTRUN_ATTACH_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_DAEMON_URL", "AGENTRUN_INIT_ARGS", "DISPLAY"]);
	assert.equal(env.DISPLAY, ":0");
	// connect exec makes kind linux, as it always has: a desktop there is refused before any SDK call, naming the connect
	// its descriptor's desktop configuration takes.
	for (const connect of [undefined, "exec"]) {
		assert.throws(() => setup({ ...(connect ? { connect } : {}), kind: "desktop" }), /^Error: Modal gives a desktop computer on connect "dial" alone, not "exec"$/);
	}
	assert.equal(setup({ kind: "linux" }).provider.capabilities().kind, "linux");
});

test("Modal's desktop configuration, as serve builds it over connect exec, makes a desktop over dial: the sandbox boots from its env, dials, and its X server and xfwm4 start over that socket", async () => {
	const dial = dialServer();
	const sandboxes = new Map();
	let booted;
	// The SDK's slice keeping what it makes: a sandbox boots from the env it was given (bootDial), runs until terminated.
	const rec = recorder();
	const sandboxOf = (id, params) => {
		let finished = null;
		return { sandboxId: id, params, poll: async () => finished, getTags: async () => ({ ...params.tags }), terminate: async () => void (finished = 0) };
	};
	rec.sdk.sandboxes = {
		create: async (app, image, params) => {
			const sandbox = sandboxOf(`sb-${sandboxes.size + 1}`, params);
			sandboxes.set(sandbox.sandboxId, sandbox);
			booted = bootDial(params.env, dial, { daemon: readFileSync(DAEMON_PATH) });
			return sandbox;
		},
		fromId: async (id) => {
			if (!sandboxes.has(id)) throw Object.assign(new Error("Sandbox not found"), { name: "NotFoundError" });
			return sandboxes.get(id);
		},
		list: ({ tags }) => ({
			async *[Symbol.asyncIterator]() {
				yield* [...sandboxes.values()].filter(({ params }) => Object.entries(tags).every(([key, value]) => params.tags[key] === value));
			},
		}),
	};
	const { options } = MODAL.capabilities.find(({ kind }) => kind === "desktop");
	// serve's options for this provider: the keys' and the settings' (modalConnect exec), then the configuration's.
	const provider = new ModalProvider({ sdk: rec.sdk, app: APP, daemonPath: DAEMON_PATH, timeouts: { ...TIMEOUTS, listedStableMs: 0 }, dial, connect: "exec", ...options });
	assert.equal(provider.capabilities().kind, "desktop");
	assert.equal(provider.host.facts.connect, "dial");
	await desktopOverDial(provider, dial, () => booted, { image: BOX_IMAGE, lifetimeMs: 600_000, network: "none" });
	const [sandbox] = sandboxes.values();
	assert.deepEqual([sandbox.params.runtime, sandbox.params.cpuLimit, sandbox.params.memoryLimitMiB, sandbox.params.gpu], ["vm", 1, 4096, undefined], "2 CPUs (1 physical core) and 4 GiB on the VM runtime, no GPU");
	assert.equal(await sandbox.poll(), 0, "release terminated the sandbox");
});

test("the conformance module reads COMPUTER_MODAL_CONNECT as connect, and its dialKit refuses in words: this process is no public server", async () => {
	const { MODAL_ENV, settingsFromEnv, dialKit } = await import("../dist/conformance/modal.js");
	const env = { [MODAL_ENV.tokenId]: "ak-fake-test-key", [MODAL_ENV.tokenSecret]: "as-not-a-secret", [MODAL_ENV.app]: APP, [MODAL_ENV.connect]: "dial" };
	assert.equal(MODAL_ENV.connect, "COMPUTER_MODAL_CONNECT");
	assert.equal(settingsFromEnv(env).connect, "dial");
	assert.throws(() => dialKit(), /Modal's machines dial the server that minted their tokens, and this run has no public server: run its Core with packages\/serve\/scripts\/dial-conformance\.mjs --provider modal with COMPUTER_MODAL_CONNECT=dial inside a server the internet reaches at AGENTRUN_PUBLIC_URL/);
});

test("the conformance module's run image on dial is the box image, the one that holds agentrun-dial; on exec, the CLI's debian:bookworm-slim", async () => {
	const { MODAL_ENV, conformanceImage } = await import("../dist/conformance/modal.js");
	const { boxImageRef } = await import("../dist/box-image.js");
	assert.equal(conformanceImage({ env: { [MODAL_ENV.connect]: "dial" } }), boxImageRef());
	assert.equal(conformanceImage({ env: {} }), "debian:bookworm-slim");
	assert.equal(conformanceImage({ env: { [MODAL_ENV.connect]: "exec" } }), "debian:bookworm-slim");
});

test("the conformance module hands onNote, dial and the kind to the drifted twin as to the run's provider: the same desktop, the same refusal on create, the same note on release", async () => {
	const { MODAL_ENV, createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	for (const make of [createProvider, createDriftedProvider]) {
		const notes = [];
		const provider = await make({
			env: { ...MODAL_SETTINGS, ...DEV_TOKEN, [MODAL_ENV.connect]: "dial", [MODAL_ENV.kind]: "desktop" },
			ModalClient: fakeClient().ModalClient,
			...MODULE_TEST,
			onNote: (note) => notes.push(note),
			dial: {
				tokens: {
					revoke: async () => {
						throw new Error("the token store is down");
					},
				},
				hub: { revoke() {}, connection: () => undefined, online: () => false },
			},
		});
		assert.equal(provider.capabilities().kind, "desktop", make.name);
		const made = await create(provider);
		assert.equal(made.ok, false, make.name);
		assert.match(made.error.message, /has no public https address/, make.name);
		const released = await provider.release({ id: "sb-0000000000000000000001", name: "computer-0123456789ab" }, "delete");
		assert.equal(released.ok, true, `${make.name}: ${JSON.stringify(released)}`);
		assert.equal(notes.length, 1, `${make.name}: ${JSON.stringify(notes)}`);
		assert.match(notes[0].note, /could not be revoked \(the token store is down\)/, make.name);
	}
});

test("the conformance module's daemon: an option's path, and the drifted twin uploads the one it built, not the option's", async () => {
	const { createProvider, createDriftedProvider } = await import("../dist/conformance/modal.js");
	const options = { env: { ...MODAL_SETTINGS, ...DEV_TOKEN }, daemonPath: "/nonexistent/untangle-option/computerd", buildDaemon: async () => "/nonexistent/untangle-drift/computerd" };
	const made = await create(await createProvider({ ...options, ModalClient: fakeClient().ModalClient }));
	assert.equal(made.ok, false);
	assert.match(made.error.message, /no daemon binary at \/nonexistent\/untangle-option\/computerd/);
	const drifted = await create(await createDriftedProvider({ ...options, ModalClient: fakeClient().ModalClient }));
	assert.equal(drifted.ok, false);
	assert.match(drifted.error.message, /no daemon binary at \/nonexistent\/untangle-drift\/computerd/);
});
