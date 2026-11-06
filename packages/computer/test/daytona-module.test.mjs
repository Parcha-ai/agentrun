// The Daytona module for the conformance CLI: createProvider() reads its settings from the environment it is given, by
// name (COMPUTER_DAYTONA_* and nothing else), and refuses in words without one. A bare DAYTONA_API_KEY may hold another
// organization's key on a host that runs other Daytona work, so it is never read, not even as a fallback. The live suite
// on real Daytona skips unless both of its variables are set; this file never sets them, and gives each child an
// environment with no Daytona variable but the one under test. Every key here is an obvious fake.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import * as daytonaModule from "../dist/conformance/daytona.js";
import { API, DEFAULT_SNAPSHOT, fakeDaytona, KEY } from "./fake-daytona.mjs";

const { createProvider, DAYTONA_ENV } = daytonaModule;
const here = fileURLToPath(new URL(".", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "computer-daytona-module-"));
const DAEMON = join(dir, "computerd");
writeFileSync(DAEMON, "a stand-in for computerd\n");
after(() => rmSync(dir, { recursive: true, force: true }));

test("createProvider() names the variable it needs, and makes no request without it", () => {
	assert.throws(() => createProvider({ env: {} }), /set COMPUTER_DAYTONA_API_KEY to a Daytona API key/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: "" } }), /COMPUTER_DAYTONA_API_KEY/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.arch]: "riscv64" } }), /amd64 or arm64/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.sandboxClass]: "windows" } }), /container or linux-vm/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.user]: "0:0" } }), /root/);
	assert.deepEqual(DAYTONA_ENV, {
		key: "COMPUTER_DAYTONA_API_KEY",
		url: "COMPUTER_DAYTONA_API_URL",
		daemon: "COMPUTER_DAYTONA_DAEMON",
		arch: "COMPUTER_DAYTONA_ARCH",
		target: "COMPUTER_DAYTONA_TARGET",
		sandboxClass: "COMPUTER_DAYTONA_CLASS",
		user: "COMPUTER_DAYTONA_USER",
		snapshot: "COMPUTER_DAYTONA_SNAPSHOT",
	});
	for (const name of Object.values(DAYTONA_ENV)) assert.match(name, /^COMPUTER_DAYTONA_/, `${name} is not a bare DAYTONA_ name`);
});

const DEV_KEY = "fake-dev-key";
const PROD_KEY = "prod-key-must-not-be-used";
const PROD_API = "https://prod.daytona.test/api";

test("createProvider() never takes DAYTONA_API_KEY or DAYTONA_API_URL: without COMPUTER_DAYTONA_API_KEY it refuses, and makes no request", () => {
	const fake = fakeDaytona();
	for (const env of [
		{ DAYTONA_API_KEY: PROD_KEY },
		{ DAYTONA_API_KEY: PROD_KEY, DAYTONA_API_URL: PROD_API },
		{ DAYTONA_API_KEY: PROD_KEY, DAYTONA_API_URL: PROD_API, COMPUTER_DAYTONA_API_URL: API },
		{ DAYTONA_API_KEY: PROD_KEY, COMPUTER_DAYTONA_API_KEY: "" },
	]) {
		assert.throws(() => createProvider({ env, fetch: fake.fetch, webSocket: fake.webSocket }), (error) => {
			assert.match(error.message, /set COMPUTER_DAYTONA_API_KEY to a Daytona API key/, JSON.stringify(Object.keys(env)));
			assert.doesNotMatch(error.message, new RegExp(PROD_KEY));
			return true;
		});
	}
	assert.deepEqual(fake.requests, []);
	assert.deepEqual(fake.sockets, []);
});

test("with both keys set, Daytona sees only COMPUTER_DAYTONA_API_KEY, at COMPUTER_DAYTONA_API_URL", async () => {
	const fake = fakeDaytona();
	const provider = createProvider({
		env: { COMPUTER_DAYTONA_API_KEY: DEV_KEY, COMPUTER_DAYTONA_API_URL: API, DAYTONA_API_KEY: PROD_KEY, DAYTONA_API_URL: PROD_API },
		fetch: fake.fetch,
		webSocket: fake.webSocket,
	});
	assert.deepEqual(await provider.list({}), { ok: true, value: [] });
	assert.ok(fake.requests.length > 0);
	for (const request of fake.requests) {
		assert.equal(request.headers.authorization, `Bearer ${DEV_KEY}`, `${request.method} ${request.host}${request.path}`);
		assert.equal(request.host, "api.daytona.test");
		assert.doesNotMatch(JSON.stringify(request), new RegExp(PROD_KEY));
	}
});

test("createProvider() builds the provider from the settings it is given, and it talks to the given API only", async () => {
	const fake = fakeDaytona();
	const provider = createProvider({
		env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.url]: API, [DAYTONA_ENV.sandboxClass]: "linux-vm", [DAYTONA_ENV.target]: "eu", [DAYTONA_ENV.user]: "2000:2000" },
		fetch: fake.fetch,
		webSocket: fake.webSocket,
	});
	assert.equal(provider.id, "daytona");
	assert.equal(provider.capabilities().isolation, "vm");
	assert.match(provider.check({ image: "s", lifetimeMs: 1, network: "none", user: "0" })[0].message, /2000:2000/);
	const listed = await provider.list({});
	assert.deepEqual(listed, { ok: true, value: [] });
	assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.host}${r.path}`), ["GET api.daytona.test/api/sandbox"]);
});

test('the run\'s image is COMPUTER_DAYTONA_SNAPSHOT, or "default" (Daytona\'s default snapshot) when it is unset', () => {
	assert.equal(typeof daytonaModule.conformanceImage, "function", "the module exports conformanceImage()");
	assert.equal(daytonaModule.conformanceImage({ env: {} }), "default");
	assert.equal(daytonaModule.conformanceImage({ env: { [DAYTONA_ENV.snapshot]: "" } }), "default");
	assert.equal(daytonaModule.conformanceImage({ env: { [DAYTONA_ENV.snapshot]: "my-snapshot" } }), "my-snapshot");
	assert.equal(daytonaModule.conformanceImage({ env: { DAYTONA_SNAPSHOT: "theirs" } }), "default", "never a bare DAYTONA_ name");
});

test("createProvider() bounds every sandbox's life besides the TTL: autoStopMinutes 30 and autoDeleteMinutes 0, whatever the environment", async () => {
	const fake = fakeDaytona();
	const env = { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.url]: API, [DAYTONA_ENV.daemon]: DAEMON, COMPUTER_DAYTONA_AUTO_STOP: "0", COMPUTER_DAYTONA_AUTO_DELETE: "-1" };
	const provider = createProvider({ env, fetch: fake.fetch, webSocket: fake.webSocket });
	const made = await provider.create({ image: daytonaModule.conformanceImage({ env }), lifetimeMs: 600_000, network: "none" });
	assert.equal(made.ok, true, JSON.stringify(made));
	const post = fake.requests.find((r) => r.method === "POST" && r.path === "/api/sandbox");
	assert.equal(post.body.autoStopInterval, 30);
	assert.equal(post.body.autoDeleteInterval, 0);
	assert.equal(post.body.ttlMinutes, 10);
	assert.equal(Object.hasOwn(post.body, "snapshot"), false, "the default snapshot: no snapshot field");
	assert.equal(fake.sandboxes.get(made.value.id).snapshot, DEFAULT_SNAPSHOT);
	assert.deepEqual(await provider.release(made.value, "stop"), { ok: true, value: undefined });
	assert.equal(fake.sandboxes.size, 0, "a stop deletes it");
});

test("the module's note for the run's report says a stop deletes, and which cases that fails", () => {
	const notes = daytonaModule.conformanceNotes;
	assert.ok(Array.isArray(notes) && notes.length > 0 && notes.every((note) => typeof note === "string"), "the module exports conformanceNotes, strings");
	const text = notes.join(" ");
	assert.match(text, /autoStopMinutes 30/);
	assert.match(text, /autoDeleteMinutes 0/);
	assert.match(text, /provider\.stop/);
	assert.match(text, /provider\.janitor/);
});

test("the CLI loads the Daytona module and fails in words, exit 1, without a key", async () => {
	// A child with PATH alone: whatever this process's environment holds, the CLI finds no key.
	const cli = fileURLToPath(new URL("../dist/conformance/cli.js", import.meta.url));
	const ran = await new Promise((resolve) => {
		execFile(process.execPath, [cli, "--provider", "../dist/conformance/daytona.js", "--image", "snapshot"], { cwd: here, env: { PATH: process.env.PATH, INIT_CWD: here } }, (error, stdout, stderr) =>
			resolve({ code: error?.code ?? 0, stdout, stderr }),
		);
	});
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /set COMPUTER_DAYTONA_API_KEY to a Daytona API key/);
});

/** Runs the live file with an environment of PATH and the given variables alone, and returns its TAP. */
function live(env) {
	return new Promise((resolve) => {
		execFile(process.execPath, ["--test", "--test-reporter=tap", "daytona/conformance.daytona.test.mjs"], { cwd: here, env: { PATH: process.env.PATH, ...env } }, (_error, stdout) => resolve(stdout));
	});
}

test("the live suite on real Daytona skips unless both AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and COMPUTER_DAYTONA_API_KEY are set, whatever DAYTONA_API_KEY holds", async () => {
	for (const env of [
		{},
		{ AGENTRUN_COMPUTER_LIVE_DAYTONA: "1" },
		{ COMPUTER_DAYTONA_API_KEY: DEV_KEY },
		{ AGENTRUN_COMPUTER_LIVE_DAYTONA: "0", COMPUTER_DAYTONA_API_KEY: DEV_KEY },
		{ AGENTRUN_COMPUTER_LIVE_DAYTONA: "1", DAYTONA_API_KEY: PROD_KEY },
		{ AGENTRUN_COMPUTER_LIVE_DAYTONA: "1", DAYTONA_API_KEY: PROD_KEY, DAYTONA_API_URL: PROD_API },
	]) {
		const tap = await live(env);
		assert.match(tap, /# SKIP set AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and COMPUTER_DAYTONA_API_KEY/, JSON.stringify(env));
		assert.match(tap, /# pass 0/);
		assert.match(tap, /# fail 0/);
	}
});
