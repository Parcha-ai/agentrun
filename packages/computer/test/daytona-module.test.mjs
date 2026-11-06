// The Daytona module for the conformance CLI: createProvider() reads its settings from the environment it is given, by
// name, and refuses in words without one. The live suite on real Daytona skips unless both of its variables are set; this
// file never sets them, and gives each child an environment with no Daytona variable but the one under test.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createProvider, DAYTONA_ENV } from "../dist/conformance/daytona.js";
import { API, fakeDaytona, KEY } from "./fake-daytona.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

test("createProvider() names the variable it needs, and makes no request without it", () => {
	assert.throws(() => createProvider({ env: {} }), /set DAYTONA_API_KEY to a Daytona API key/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: "" } }), /DAYTONA_API_KEY/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.arch]: "riscv64" } }), /amd64 or arm64/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.sandboxClass]: "windows" } }), /container or linux-vm/);
	assert.throws(() => createProvider({ env: { [DAYTONA_ENV.key]: KEY, [DAYTONA_ENV.user]: "0:0" } }), /root/);
	assert.deepEqual(DAYTONA_ENV, {
		key: "DAYTONA_API_KEY",
		url: "DAYTONA_API_URL",
		daemon: "AGENTRUN_DAYTONA_DAEMON",
		arch: "AGENTRUN_DAYTONA_ARCH",
		target: "AGENTRUN_DAYTONA_TARGET",
		sandboxClass: "AGENTRUN_DAYTONA_CLASS",
		user: "AGENTRUN_DAYTONA_USER",
	});
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

test("the CLI loads the Daytona module and fails in words, exit 1, without a key", async () => {
	// A child with PATH alone: whatever this process's environment holds, the CLI finds no key.
	const cli = fileURLToPath(new URL("../dist/conformance/cli.js", import.meta.url));
	const ran = await new Promise((resolve) => {
		execFile(process.execPath, [cli, "--provider", "../dist/conformance/daytona.js", "--image", "snapshot"], { cwd: here, env: { PATH: process.env.PATH, INIT_CWD: here } }, (error, stdout, stderr) =>
			resolve({ code: error?.code ?? 0, stdout, stderr }),
		);
	});
	assert.equal(ran.code, 1);
	assert.match(ran.stderr, /set DAYTONA_API_KEY to a Daytona API key/);
});

/** Runs the live file with an environment of PATH and the given variables alone, and returns its TAP. */
function live(env) {
	return new Promise((resolve) => {
		execFile(process.execPath, ["--test", "--test-reporter=tap", "daytona/conformance.daytona.test.mjs"], { cwd: here, env: { PATH: process.env.PATH, ...env } }, (_error, stdout) => resolve(stdout));
	});
}

test("the live suite on real Daytona skips unless both AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and DAYTONA_API_KEY are set", async () => {
	for (const env of [{}, { AGENTRUN_COMPUTER_LIVE_DAYTONA: "1" }, { DAYTONA_API_KEY: "not-a-key" }, { AGENTRUN_COMPUTER_LIVE_DAYTONA: "0", DAYTONA_API_KEY: "not-a-key" }]) {
		const tap = await live(env);
		assert.match(tap, /# SKIP set AGENTRUN_COMPUTER_LIVE_DAYTONA=1 and DAYTONA_API_KEY/, JSON.stringify(env));
		assert.match(tap, /# pass 0/);
		assert.match(tap, /# fail 0/);
	}
});
