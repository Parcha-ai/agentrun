// provider.prepare-image: a provider's prepareImage() and its descriptor's flag agree, and a provider with
// prepareImage() is asked for its image twice in one run: the second call finds the image the first made by its name,
// with no build and no pull. The providers here sit on the fake host (test/fake-host.mjs) with an in-memory vendor that
// builds images by name, the shape PROVIDERS.md's worked example has: boot the base, run box/install.sh, snapshot. And
// PROVIDERS.md's Dockerfile example, on an in-memory builder: find the image by name in the vendor's list, or build the
// box Dockerfile under that name. No network, no vendor.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FAKE_DESCRIPTOR, fakeHost } from "./fake-host.mjs";

const { HostedProvider } = await import("../dist/hosted/provider.js");
const { codeOfError } = await import("../dist/hosted/process.js");
const { conformanceCases, runConformance } = await import("../dist/index.js");
const { recipeHash } = await import("../box/recipe.mjs");

const CASE = "provider.prepare-image";
const dir = mkdtempSync(join(tmpdir(), "computer-image-"));
const DAEMON_PATH = join(dir, "computerd");
writeFileSync(DAEMON_PATH, "a stand-in for computerd, linux/amd64\n");
test.after(() => rmSync(dir, { recursive: true, force: true }));
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, uploadMs: 2_000, execMs: 2_000, helloMs: 1_000, probeMs: 1_000, listMs: 2_000, goneMs: 500, pollMs: 5, listedMs: 500, listedStableMs: 0, mountMs: 2_000 };
const NAME = `agentrun-box-${recipeHash()}`;

const BOX = new URL("../box/", import.meta.url);

/**
 * A vendor that builds images in the account, in memory: its snapshots by name, the machines it booted, what ran on each.
 * Like a vendor's API, every call refuses once its signal is aborted, and a snapshot refuses a name the account has.
 * `hold` makes run wait until it is resolved (or the call's signal aborts), so a test can cancel a build mid-way.
 */
function vendor({ hold } = {}) {
	const account = { snapshots: new Set(), booted: [], ran: [], deleted: [] };
	const live = (ctx) => ctx?.signal?.throwIfAborted();
	account.client = {
		findSnapshot: async (name, ctx) => (live(ctx), account.snapshots.has(name)),
		boot: async (image, ctx) => (live(ctx), `vm-${account.booted.push(image)}`),
		upload: async (machine, path, bytes, ctx) => (live(ctx), account.ran.push(`${machine}: upload ${path}, ${bytes.length} bytes`)),
		run: async (machine, argv, ctx) => {
			live(ctx);
			account.ran.push(`${machine}: ${argv.join(" ")}`);
			if (hold) await new Promise((resolve, reject) => (hold.then(resolve), ctx?.signal?.addEventListener("abort", () => reject(ctx.signal.reason))));
		},
		snapshot: async (machine, name, ctx) => {
			live(ctx);
			if (account.snapshots.has(name)) throw new Error(`a snapshot named ${name} exists`);
			account.snapshots.add(name);
		},
		delete: async (machine, ctx) => (live(ctx), account.deleted.push(machine)),
	};
	return account;
}

/**
 * A provider on the fake host, its vendor's client on the host, whose prepareImage is PROVIDERS.md's worked example: it
 * finds the box image by name, or else boots the base, runs install.sh and snapshots. declares sets its descriptor's
 * prepareImage flag.
 */
function imageProvider(account, { declares = true } = {}) {
	const host = Object.assign(fakeHost({ descriptor: { ...FAKE_DESCRIPTOR, prepareImage: declares } }).host, { client: account.client });
	return new (class extends HostedProvider {
		async prepareImage(ctx = {}) {
			const name = `agentrun-box-${recipeHash()}`;
			const vendor = this.host.client;
			try {
				if (await vendor.findSnapshot(name, ctx)) return { ok: true, value: name };
				ctx.onWait?.("build", name);
				const machine = await vendor.boot("python:3.12-slim", ctx);
				try {
					for (const file of ["install.sh", "agentrun-archil"]) await vendor.upload(machine, `/tmp/agentrun-box/${file}`, await readFile(new URL(file, BOX)), ctx);
					await vendor.run(machine, ["sh", "-c", "sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box"], ctx);
					await vendor.snapshot(machine, name, ctx).catch(async (error) => {
						if (!(await vendor.findSnapshot(name, ctx))) throw error;
					});
				} finally {
					await vendor.delete(machine, { signal: AbortSignal.timeout(60_000) });
				}
				return { ok: true, value: name };
			} catch (error) {
				return { ok: false, error: { code: codeOfError(this.host, error), message: `building the box image ${name}: ${error instanceof Error ? error.message : String(error)}` } };
			}
		}
	})(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
}

const run = async (provider) => {
	const report = await runConformance(provider, { image: "img", cases: conformanceCases.filter((one) => one.id === CASE), cleanupTimeoutMs: 2_000, caseTimeoutMs: 20_000 });
	assert.equal(report.results.length, 1);
	return report;
};

test("provider.prepare-image is a Core case of the provider group that makes no computer, with time for a first build on a vendor", () => {
	const found = conformanceCases.find((one) => one.id === CASE);
	assert.ok(found, "the case is in the suite");
	assert.deepEqual([found.level, found.group, found.computer, found.needs], ["core", "provider", "none", []]);
	assert.ok(found.timeoutMs >= 15 * 60_000, "a first build or registration on a vendor takes minutes (Agent37's waits up to 15)");
});

test("provider.prepare-image checks that the descriptor's flag and the provider's method agree", async () => {
	const account = vendor();
	const agreeing = await run(imageProvider(account));
	assert.equal(agreeing.results[0].status, "pass", agreeing.results[0].reason);
	assert.deepEqual(agreeing.results[0].observed, [`the first prepareImage was told onWait(build ${NAME}) and answered ${NAME}`]);
	assert.equal(account.booted.length, 1, "one build for the two calls");
	const unsaid = await run(imageProvider(account, { declares: false }));
	assert.equal(unsaid.results[0].status, "fail");
	assert.equal(unsaid.results[0].reason, "Fakehost's provider has prepareImage() but its descriptor does not declare prepareImage: Settings never calls it");
	const named = await run(new HostedProvider(fakeHost().host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }));
	assert.equal(named.results[0].status, "pass", named.results[0].reason);
	const declared = await run(new HostedProvider(fakeHost({ descriptor: { ...FAKE_DESCRIPTOR, prepareImage: true } }).host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }));
	assert.equal(declared.results[0].status, "fail");
	assert.equal(declared.results[0].reason, "Fakehost's descriptor declares prepareImage, but its provider has no prepareImage(): give the provider class one");
});

test("the worked example builds the box image once and finds it by name after: no onWait then", async () => {
	const account = vendor();
	const provider = imageProvider(account);
	const told = [];
	assert.deepEqual(await provider.prepareImage({ onWait: (...args) => told.push(args) }), { ok: true, value: NAME });
	assert.deepEqual(told, [["build", NAME]]);
	// One build: the base booted, install.sh and the helper put beside each other and run as root, the machine
	// snapshotted under the recipe's name and deleted.
	const size = (file) => readFileSync(new URL(file, BOX)).length;
	assert.deepEqual(account.booted, ["python:3.12-slim"]);
	assert.deepEqual(account.ran, [
		`vm-1: upload /tmp/agentrun-box/install.sh, ${size("install.sh")} bytes`,
		`vm-1: upload /tmp/agentrun-box/agentrun-archil, ${size("agentrun-archil")} bytes`,
		"vm-1: sh -c sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box",
	]);
	assert.deepEqual([...account.snapshots], [NAME]);
	assert.deepEqual(account.deleted, ["vm-1"]);
	assert.deepEqual(await provider.prepareImage({ onWait: (...args) => told.push(args) }), { ok: true, value: NAME });
	assert.equal(told.length, 1, "the second call is told no onWait");
	assert.equal(account.booted.length, 1, "no second build");
});

const until = async (done) => {
	for (let tick = 0; !done(); tick++) {
		assert.ok(tick < 1_000, "the builds got to their run");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
};
const runs = (account) => account.ran.filter((line) => line.endsWith("rm -rf /tmp/agentrun-box")).length;

test("two servers that build the same recipe at once both answer its image: the one whose snapshot is refused finds the other's", async () => {
	let release;
	const account = vendor({ hold: new Promise((resolve) => (release = resolve)) });
	const both = Promise.all([imageProvider(account), imageProvider(account)].map((one) => one.prepareImage()));
	await until(() => runs(account) === 2);
	release();
	assert.deepEqual(await both, [{ ok: true, value: NAME }, { ok: true, value: NAME }]);
	assert.deepEqual([...account.snapshots], [NAME]);
	assert.deepEqual(account.deleted.toSorted(), ["vm-1", "vm-2"], "each build deletes its machine");
	// A snapshot refused for any other reason (the name is still free) is the build's failure.
	const refusing = vendor();
	refusing.client.snapshot = async () => {
		throw new Error("the account is at its snapshot quota");
	};
	const refused = await imageProvider(refusing).prepareImage();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.message, `building the box image ${NAME}: the account is at its snapshot quota`);
	assert.deepEqual(refusing.deleted, ["vm-1"]);
});

// --- the Dockerfile path: a vendor that builds the box Dockerfile itself (Hyperbrowser's remote builder; Vercel's
// `vercel vcr build docker . agentrun-box:<hash> --push`) and starts computers from it by name ---

/**
 * A vendor whose builder takes a Dockerfile and its context and makes an image under a name, in memory: its images by
 * name, each building, ready or failed, found only by listing them all (Hyperbrowser has no get by name), and every
 * build asked of it. A build refuses a name the account has, else starts the image building and answers at once; `ready` waits until the image of that name is
 * ready (or failed, or the call's signal aborts), and answers the name a create then names. A test finishes a build.
 */
function builder() {
	const account = { images: [], builds: [] };
	const live = (ctx) => ctx?.signal?.throwIfAborted();
	const named = (name) => account.images.find((image) => image.name === name);
	account.lists = 0;
	account.client = {
		listImages: async (ctx) => {
			live(ctx);
			const images = account.images.map((image) => ({ ...image }));
			account.lists++;
			await account.listed; // a test holds the answers back until every caller has listed
			return images;
		},
		build: async (name, context, ctx) => {
			live(ctx);
			account.builds.push({ name, context });
			if (named(name)) throw new Error(`an image named ${name} exists`);
			account.images.push({ name, status: account.hold ? "building" : "ready" });
		},
		ready: async (name, ctx) => {
			for (;;) {
				live(ctx);
				const image = named(name);
				if (image?.status === "ready") return name;
				if (image?.status === "failed") throw new Error(`the build of ${name} failed: ${image.error}`);
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		},
	};
	account.finish = (name, status = "ready", error) => Object.assign(named(name), { status, error });
	return account;
}

/** PROVIDERS.md's Dockerfile example on the fake host: the box image found by its name in the list (findsByName), or built. */
function dockerfileProvider(account, { findsByName }) {
	const host = Object.assign(fakeHost({ descriptor: { ...FAKE_DESCRIPTOR, prepareImage: true } }).host, { client: account.client });
	return new (class extends HostedProvider {
		async prepareImage(ctx = {}) {
			const name = `agentrun-box-${recipeHash()}`;
			const vendor = this.host.client;
			try {
				const image = findsByName ? (await vendor.listImages(ctx)).find((one) => one.name === name) : undefined;
				if (image?.status === "failed") throw new Error(`its last build failed (${image.error}): delete ${name} in the account, then call again`);
				if (image === undefined) {
					ctx.onWait?.("build", name);
					const box = (file) => readFile(new URL(file, BOX));
					await vendor.build(name, { Dockerfile: await box("Dockerfile"), "install.sh": await box("install.sh"), "agentrun-archil": await box("agentrun-archil") }, ctx).catch(async (error) => {
						if (!(await vendor.listImages(ctx)).some((one) => one.name === name)) throw error;
					});
				}
				return { ok: true, value: await vendor.ready(name, ctx) };
			} catch (error) {
				return { ok: false, error: { code: codeOfError(this.host, error), message: `building the box image ${name}: ${error instanceof Error ? error.message : String(error)}` } };
			}
		}
	})(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
}

test("on the Dockerfile path, a prepareImage that finds its name in the vendor's list passes: one build of the box Dockerfile and its context, and both calls answer the name", async () => {
	const account = builder();
	// Another recipe's image in the list is not this one.
	account.images.push({ name: "agentrun-box-000000000000", status: "ready" });
	const report = await run(dockerfileProvider(account, { findsByName: true }));
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
	assert.deepEqual(result.observed, [`the first prepareImage was told onWait(build ${NAME}) and answered ${NAME}`]);
	assert.equal(account.builds.length, 1);
	const [{ context }] = account.builds;
	// The box Dockerfile as it is, with the two files it copies: a builder that uploads a context builds it unchanged.
	assert.deepEqual(Object.keys(context), ["Dockerfile", "install.sh", "agentrun-archil"]);
	for (const file of Object.keys(context)) assert.deepEqual(context[file], readFileSync(new URL(file, BOX)), file);
	// The next run on an account that has the image builds nothing.
	const again = await run(dockerfileProvider(account, { findsByName: true }));
	assert.equal(again.results[0].status, "pass", again.results[0].reason);
	assert.deepEqual(again.results[0].observed, [`the first prepareImage found ${NAME} and was told no onWait`]);
	assert.equal(account.builds.length, 1, "no build on the next run");
});

test("on the Dockerfile path, a prepareImage that builds every call fails Core in the same words", async () => {
	const account = builder();
	const [result] = (await run(dockerfileProvider(account, { findsByName: false }))).results;
	assert.equal(result.status, "fail");
	assert.equal(result.reason, `the second prepareImage was told onWait(build ${NAME}): it must find the image the first made by its name (one that carries the box recipe's hash) and answer it with no build and no pull`);
	assert.equal(account.builds.length, 2, "a build for each call");
});

test("on the Dockerfile path, an image of that name still building is another server's build: waited for, never built again; a failed one fails in words, with no build", async () => {
	const account = builder();
	account.hold = true;
	const told = [];
	const first = dockerfileProvider(account, { findsByName: true }).prepareImage({ onWait: (making, tag) => told.push(`${making} ${tag}`) });
	await until(() => account.images.length === 1);
	const second = dockerfileProvider(account, { findsByName: true }).prepareImage({ onWait: (making, tag) => told.push(`${making} ${tag}`) });
	await new Promise((resolve) => setTimeout(resolve, 20));
	account.finish(NAME);
	assert.deepEqual(await Promise.all([first, second]), [{ ok: true, value: NAME }, { ok: true, value: NAME }]);
	assert.equal(account.builds.length, 1, "one build: the second waited for the first's");
	assert.deepEqual(told, [`build ${NAME}`], "only the build is told onWait");

	// Two servers that both list before either builds: the vendor refuses the second build, as the name is taken, and
	// that server finds the first's image and waits on it.
	const raced = builder();
	raced.hold = true;
	let answerLists;
	raced.listed = new Promise((resolve) => (answerLists = resolve));
	const both = Promise.all([0, 1].map(() => dockerfileProvider(raced, { findsByName: true }).prepareImage()));
	await until(() => raced.lists === 2);
	answerLists();
	await until(() => raced.builds.length === 2);
	raced.finish(NAME);
	assert.deepEqual(await both, [{ ok: true, value: NAME }, { ok: true, value: NAME }]);
	assert.equal(raced.images.length, 1, "one image: the second build was refused, not run");
	// A refusal while the name is still free is the build's failure.
	const quota = builder();
	quota.client.build = async () => {
		throw new Error("the team is at its image quota");
	};
	const over = await dockerfileProvider(quota, { findsByName: true }).prepareImage();
	assert.equal(over.ok, false);
	assert.equal(over.error.message, `building the box image ${NAME}: the team is at its image quota`);

	const failed = builder();
	failed.images.push({ name: NAME, status: "failed", error: "install.sh exited 1" });
	const refused = await dockerfileProvider(failed, { findsByName: true }).prepareImage();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.message, `building the box image ${NAME}: its last build failed (install.sh exited 1): delete ${NAME} in the account, then call again`);
	assert.equal(failed.builds.length, 0, "a failed image is not built over");
});

test("a build cancelled by the caller's signal still deletes its machine: the delete has its own deadline", async () => {
	const account = vendor({ hold: new Promise(() => {}) });
	const controller = new AbortController();
	const answer = imageProvider(account).prepareImage({ signal: controller.signal });
	await until(() => runs(account) === 1);
	controller.abort(new Error("the server is shutting down"));
	const result = await answer;
	assert.equal(result.ok, false);
	assert.equal(result.error.message, `building the box image ${NAME}: the server is shutting down`);
	assert.deepEqual(account.snapshots.size, 0);
	assert.deepEqual(account.deleted, ["vm-1"], "the machine is deleted, though the caller's signal is aborted");
});
