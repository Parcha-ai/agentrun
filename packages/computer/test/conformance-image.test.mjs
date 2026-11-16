// provider.prepare-image, the twice-call case: a provider with prepareImage() is asked for its image twice in one run,
// and the second call finds the image the first made by its name, with no build and no pull. The providers here sit on
// the fake host (test/fake-host.mjs) with an in-memory vendor that builds images by name, the shape PROVIDERS.md's
// worked example has: boot the base, run box/install.sh, snapshot. And PROVIDERS.md's registry example, on an in-memory
// registry: build box/recipe.mjs's vendorDockerfile, push it under its hash, find that tag first. No network, no vendor.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
 * finds the box image by name (findsByName), or else boots the base, runs install.sh and snapshots. Without findsByName
 * it builds every call.
 */
function imageProvider(account, { findsByName }) {
	const host = Object.assign(fakeHost().host, { client: account.client });
	return new (class extends HostedProvider {
		async prepareImage(ctx = {}) {
			const name = `agentrun-box-${recipeHash()}`;
			const vendor = this.host.client;
			try {
				if (findsByName && (await vendor.findSnapshot(name, ctx))) return { ok: true, value: name };
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

test("a provider whose prepareImage finds its image by name passes: both calls answer it, the first builds once, the second is told no onWait", async () => {
	const account = vendor();
	const report = await run(imageProvider(account, { findsByName: true }));
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
	assert.equal(report.core, "pass");
	assert.deepEqual(result.observed, [`the first prepareImage was told onWait(build ${NAME}) and answered ${NAME}`]);
	// One build in the run: the base booted, install.sh and the helper put beside each other and run as root, the
	// machine snapshotted under the recipe's name and deleted.
	const size = (file) => readFileSync(new URL(file, BOX)).length;
	assert.deepEqual(account.booted, ["python:3.12-slim"]);
	assert.deepEqual(account.ran, [
		`vm-1: upload /tmp/agentrun-box/install.sh, ${size("install.sh")} bytes`,
		`vm-1: upload /tmp/agentrun-box/agentrun-archil, ${size("agentrun-archil")} bytes`,
		"vm-1: sh -c sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box",
	]);
	assert.deepEqual([...account.snapshots], [NAME]);
	assert.deepEqual(account.deleted, ["vm-1"]);
	// A run on an account that has the image already builds nothing.
	const again = await run(imageProvider(account, { findsByName: true }));
	assert.equal(again.results[0].status, "pass", again.results[0].reason);
	assert.deepEqual(again.results[0].observed, [`the first prepareImage found ${NAME} and was told no onWait`]);
	assert.equal(account.booted.length, 1, "no build on the next run");
});

test("a provider whose prepareImage builds every time fails Core, in words that say what to do", async () => {
	const account = vendor();
	const report = await run(imageProvider(account, { findsByName: false }));
	const [result] = report.results;
	assert.equal(result.status, "fail");
	assert.equal(report.core, "fail");
	assert.equal(
		result.reason,
		`the second prepareImage was told onWait(build ${NAME}): it must find the image the first made by its name (one that carries the box recipe's hash) and answer it with no build and no pull`,
	);
	assert.deepEqual(account.booted, ["python:3.12-slim", "python:3.12-slim"], "a build for each call");
});

test("a second call that answers another image fails, and one whose call fails fails in its own words", async () => {
	let calls = 0;
	const drifting = new (class extends HostedProvider {
		async prepareImage() {
			return { ok: true, value: `img-${++calls}` };
		}
	})(fakeHost().host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const [moved] = (await run(drifting)).results;
	assert.equal(moved.status, "fail");
	assert.equal(moved.reason, 'the second prepareImage\'s image: expected "img-1", got "img-2"');
	const failing = new (class extends HostedProvider {
		async prepareImage() {
			return { ok: false, error: { code: "unauthorized", message: "the key may not read snapshots" } };
		}
	})(fakeHost().host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
	const [refused] = (await run(failing)).results;
	assert.equal(refused.status, "fail");
	assert.match(refused.reason, /^the first prepareImage: unauthorized: the key may not read snapshots/);
});

test("a provider with no prepareImage passes, observed; a host whose descriptor declares prepareImage with none fails", async () => {
	const named = await run(new HostedProvider(fakeHost().host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }));
	assert.equal(named.results[0].status, "pass", named.results[0].reason);
	assert.deepEqual(named.results[0].observed, ["the provider has no prepareImage(): its computers start from an image a spec names"]);
	const declared = await run(new HostedProvider(fakeHost({ descriptor: { ...FAKE_DESCRIPTOR, prepareImage: true } }).host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS }));
	assert.equal(declared.results[0].status, "fail");
	assert.equal(declared.results[0].reason, "Fakehost's descriptor declares prepareImage, but its provider has no prepareImage(): give the provider class one");
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
	const both = Promise.all([imageProvider(account, { findsByName: true }), imageProvider(account, { findsByName: true })].map((one) => one.prepareImage()));
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
	const refused = await imageProvider(refusing, { findsByName: true }).prepareImage();
	assert.equal(refused.ok, false);
	assert.equal(refused.error.message, `building the box image ${NAME}: the account is at its snapshot quota`);
	assert.deepEqual(refusing.deleted, ["vm-1"]);
});

// --- the registry path: a vendor that pulls a registry image, or needs its own agent in the image ---

const { vendorDockerfile } = await import("../box/recipe.mjs");
/** The vendor's base, its agent and the entrypoint that starts it: a sandbox API the vendor needs as the first process. */
const VENDOR = { base: "vendor.example/base:bookworm", agent: ["COPY --from=vendor.example/sandbox-agent:1.4 /sandbox-agent /usr/local/bin/sandbox-agent"], start: ['ENTRYPOINT ["/usr/local/bin/sandbox-agent"]'] };
const REPOSITORY = "registry.example/acct-1/agentrun-box";

/**
 * A vendor whose computers start from an image in the account's registry, in memory: its tags and their digests, and
 * every build its builder ran (the Dockerfile and the context's files). A build pushes its tag and answers the digest.
 */
function registry() {
	const account = { tags: new Map(), builds: [] };
	const live = (ctx) => ctx?.signal?.throwIfAborted();
	account.client = {
		findImage: async (tag, ctx) => (live(ctx), account.tags.get(tag)),
		buildAndPush: async (tag, context, ctx) => {
			live(ctx);
			account.builds.push({ tag, context });
			const digest = `${tag.slice(0, tag.lastIndexOf(":"))}@sha256:${createHash("sha256").update(context.Dockerfile).digest("hex")}`;
			account.tags.set(tag, digest);
			return digest;
		},
	};
	return account;
}

/** PROVIDERS.md's registry example on the fake host: the box image on the vendor's base, found by its tag (findsByTag) or built and pushed. */
function registryProvider(account, { findsByTag }) {
	const host = Object.assign(fakeHost().host, { client: account.client });
	return new (class extends HostedProvider {
		async prepareImage(ctx = {}) {
			const { dockerfile, hash } = vendorDockerfile(VENDOR.base, { agent: VENDOR.agent, start: VENDOR.start });
			const tag = `${REPOSITORY}:${hash}`;
			const vendor = this.host.client;
			try {
				const found = findsByTag ? await vendor.findImage(tag, ctx) : undefined;
				if (found) return { ok: true, value: found };
				ctx.onWait?.("build", tag);
				const box = (file) => readFile(new URL(file, BOX));
				return { ok: true, value: await vendor.buildAndPush(tag, { Dockerfile: dockerfile, "install.sh": await box("install.sh"), "agentrun-archil": await box("agentrun-archil") }, ctx) };
			} catch (error) {
				return { ok: false, error: { code: codeOfError(this.host, error), message: `building the box image ${tag}: ${error instanceof Error ? error.message : String(error)}` } };
			}
		}
	})(host, { daemonPath: DAEMON_PATH, timeouts: TIMEOUTS });
}

test("on the registry path, a prepareImage that finds its tag passes: one build of the vendor's Dockerfile, pushed under the recipe's hash, and both calls answer its digest", async () => {
	const account = registry();
	const report = await run(registryProvider(account, { findsByTag: true }));
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
	const { dockerfile, hash } = vendorDockerfile(VENDOR.base, { agent: VENDOR.agent, start: VENDOR.start });
	const tag = `${REPOSITORY}:${hash}`;
	const digest = account.tags.get(tag);
	assert.match(digest, new RegExp(`^${REPOSITORY}@sha256:[0-9a-f]{64}$`));
	assert.deepEqual(result.observed, [`the first prepareImage was told onWait(build ${tag}) and answered ${digest}`]);
	assert.equal(account.builds.length, 1);
	const [{ context }] = account.builds;
	assert.equal(context.Dockerfile, dockerfile);
	assert.deepEqual(Object.keys(context).sort(), ["Dockerfile", "agentrun-archil", "install.sh"], "the context is the Dockerfile and what it copies");
	assert.deepEqual(context["install.sh"], readFileSync(new URL("install.sh", BOX)));
	// The next run on an account that has the tag builds nothing.
	const again = await run(registryProvider(account, { findsByTag: true }));
	assert.equal(again.results[0].status, "pass", again.results[0].reason);
	assert.deepEqual(again.results[0].observed, [`the first prepareImage found ${digest} and was told no onWait`]);
	assert.equal(account.builds.length, 1, "no build on the next run");
});

test("on the registry path, a prepareImage that builds and pushes every call fails Core in the same words", async () => {
	const account = registry();
	const [result] = (await run(registryProvider(account, { findsByTag: false }))).results;
	const tag = `${REPOSITORY}:${vendorDockerfile(VENDOR.base, { agent: VENDOR.agent, start: VENDOR.start }).hash}`;
	assert.equal(result.status, "fail");
	assert.equal(result.reason, `the second prepareImage was told onWait(build ${tag}): it must find the image the first made by its name (one that carries the box recipe's hash) and answer it with no build and no pull`);
	assert.equal(account.builds.length, 2, "a build and a push for each call");
});

test("a build cancelled by the caller's signal still deletes its machine: the delete has its own deadline", async () => {
	const account = vendor({ hold: new Promise(() => {}) });
	const controller = new AbortController();
	const answer = imageProvider(account, { findsByName: true }).prepareImage({ signal: controller.signal });
	await until(() => runs(account) === 1);
	controller.abort(new Error("the server is shutting down"));
	const result = await answer;
	assert.equal(result.ok, false);
	assert.equal(result.error.message, `building the box image ${NAME}: the server is shutting down`);
	assert.deepEqual(account.snapshots.size, 0);
	assert.deepEqual(account.deleted, ["vm-1"], "the machine is deleted, though the caller's signal is aborted");
});
