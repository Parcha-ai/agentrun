// provider.prepare-image, the twice-call case: a provider with prepareImage() is asked for its image twice in one run,
// and the second call finds the image the first made by its name, with no build and no pull. The providers here sit on
// the fake host (test/fake-host.mjs) with an in-memory vendor that builds images by name, the shape PROVIDERS.md's
// worked example has: boot the base, run box/install.sh, snapshot. No network, no vendor.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FAKE_DESCRIPTOR, fakeHost } from "./fake-host.mjs";

const { HostedProvider } = await import("../dist/hosted/provider.js");
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

/** A vendor that builds images in the account, in memory: its snapshots by name, the machines it booted, what ran on each. */
function vendor() {
	const account = { snapshots: new Set(), booted: [], ran: [], deleted: [] };
	account.client = {
		findSnapshot: async (name) => account.snapshots.has(name),
		boot: async (image) => `vm-${account.booted.push(image)}`,
		upload: async (machine, path, bytes) => account.ran.push(`${machine}: upload ${path}, ${bytes.length} bytes`),
		run: async (machine, argv) => account.ran.push(`${machine}: ${argv.join(" ")}`),
		snapshot: async (machine, name) => account.snapshots.add(name),
		delete: async (machine) => account.deleted.push(machine),
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
			if (findsByName && (await vendor.findSnapshot(name, ctx))) return { ok: true, value: name };
			ctx.onWait?.("build", name);
			const machine = await vendor.boot("python:3.12-slim", ctx);
			try {
				for (const file of ["install.sh", "agentrun-archil"]) await vendor.upload(machine, `/tmp/agentrun-box/${file}`, await readFile(new URL(file, BOX)), ctx);
				await vendor.run(machine, ["sh", "-c", "sh /tmp/agentrun-box/install.sh && rm -rf /tmp/agentrun-box"], ctx);
				await vendor.snapshot(machine, name, ctx);
			} finally {
				await vendor.delete(machine, ctx);
			}
			return { ok: true, value: name };
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
