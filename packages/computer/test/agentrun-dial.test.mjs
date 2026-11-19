// agentrun-dial, the box image's entrypoint for a machine that dials the server (box/install.sh writes it), run here as
// this user against a copy whose fixed paths are a scratch directory's. The daemon it fetches is fake bytes from a local
// server: a stand-in that records each start, its arguments and its environment. No root, no network beyond loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const INSTALL = readFileSync(new URL("../box/install.sh", import.meta.url), "utf8");
/** agentrun-dial's text, as install.sh writes it. */
const DIAL = INSTALL.match(/^\tcat >"\$DIAL" <<'EOF'\n([^]*?\n)EOF\n/m)?.[1];
/** A token of the minted shape, made here. */
const TOKEN = `art_${randomBytes(32).toString("hex")}`;
/** init's user is this one: agentrun-dial gives /workspace to it, which only root may do for another. */
const USER = `${process.getuid()}:${process.getgid()}`;
const INIT_ARGS = `--deadline 2026-11-16T12:00:00Z --user ${USER} --own-network --network allow:*.example.com`;

/** A scratch box: agentrun-dial with its fixed paths moved into it, the fake daemon's bytes, and a server for them. */
async function box(t) {
	const dir = mkdtempSync(join(tmpdir(), "computer-agentrun-dial-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = join(dir, "calls");
	// node itself runs it, with no shell between, so the environment it records is the one it was given.
	const daemon = Buffer.from(`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args, env: process.env, cwd: process.cwd() }) + "\\n");
if (command === "init") {
	require("node:net").createServer().listen(process.env.AGENTRUN_COMPUTERD_SOCKET);
	setTimeout(() => process.exit(0), 3000);
}
`);
	const fixed = {
		DAEMON: ["/opt/agentrun/computerd", join(dir, "opt", "agentrun", "computerd")],
		HOME_DIR: ["/work", join(dir, "work")],
		SOCKET_DIR: ["/run/agentrun", join(dir, "run", "agentrun")],
		INIT_LOG: ["/run/agentrun-init.log", join(dir, "run", "agentrun-init.log")],
		WORKSPACE: ["/workspace", join(dir, "workspace")],
		OWNER: ["0:0", `${process.getuid()}:${process.getgid()}`],
	};
	let script = DIAL;
	for (const [name, [shipped, here]] of Object.entries(fixed)) {
		assert.ok(script.includes(`\n${name}=${shipped}\n`), `agentrun-dial fixes ${name}=${shipped}`);
		script = script.replace(`\n${name}=${shipped}\n`, `\n${name}=${here}\n`);
	}
	mkdirSync(join(dir, "run"));
	writeFileSync(join(dir, "agentrun-dial"), script);
	// A file the init arguments' pattern would match, were they globbed.
	writeFileSync(join(dir, "allow:x.example.com"), "");
	const fetches = [];
	const server = createServer((req, res) => {
		fetches.push({ url: req.url, authorization: req.headers.authorization });
		res.end(daemon);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const env = {
		AGENTRUN_ATTACH_URL: "ws://127.0.0.1:1/v2/computers/attach",
		AGENTRUN_ATTACH_TOKEN: TOKEN,
		AGENTRUN_DAEMON_URL: `http://127.0.0.1:${server.address().port}/v2/computers/daemon?arch=amd64`,
		AGENTRUN_DAEMON_SHA256: createHash("sha256").update(daemon).digest("hex"),
		AGENTRUN_INIT_ARGS: INIT_ARGS,
		VENDOR_VARIABLE: "the vendor's own",
	};
	const run = (overrides = {}) =>
		new Promise((resolve) => {
			const child = spawn("sh", [join(dir, "agentrun-dial")], { cwd: dir, env: { ...env, ...overrides } });
			let stderr = "";
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => {
				const recorded = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
				resolve({ status, stderr, calls: recorded });
			});
		});
	return { dir, fixed, env, fetches, run };
}

test("agentrun-dial is POSIX shell that stops at the first failure, never globs and never traces, and hands the token to curl on stdin alone", () => {
	assert.ok(DIAL, "install.sh writes agentrun-dial");
	assert.match(DIAL, /^#!\/bin\/sh\n/);
	assert.match(DIAL, /^set -euf$/m);
	assert.ok(!/^\s*set\s+[^#\n]*x/m.test(DIAL) && !DIAL.includes("sh -x"), "no trace: it would print the token");
	const uses = DIAL.split("\n").filter((line) => !line.startsWith("#") && line.includes("AGENTRUN_ATTACH_TOKEN"));
	assert.deepEqual(
		uses.map((line) => line.trim().split(" ")[0]),
		["for", "printf", "case"],
		"the token is checked set, written to curl's stdin, and kept for attach: never an argument",
	);
	assert.match(INSTALL, /^DIAL=\/usr\/local\/bin\/agentrun-dial$/m);
});

test("agentrun-dial fetches the daemon with the token, installs it, starts init without the token, and becomes attach with the URL and token alone", async (t) => {
	const { fixed, env, fetches, run } = await box(t);
	const { status, stderr, calls } = await run();
	assert.equal(status, 0, stderr);
	assert.deepEqual(fetches, [{ url: "/v2/computers/daemon?arch=amd64", authorization: `Bearer ${TOKEN}` }]);
	const daemon = fixed.DAEMON[1];
	assert.equal(statSync(daemon).mode & 0o777, 0o755);
	assert.equal(statSync(fixed.SOCKET_DIR[1]).mode & 0o777, 0o700, "init's socket directory is root's alone");
	const workspace = statSync(fixed.WORKSPACE[1]);
	assert.ok(workspace.isDirectory() && (workspace.mode & 0o777) === 0o700 && `${workspace.uid}:${workspace.gid}` === USER, "/workspace is init's user's alone, for a synced folder");
	assert.ok(!existsSync(`${daemon}.part`));
	const init = calls.find((call) => call.command === "init");
	assert.ok(init, `init started: ${JSON.stringify(calls)}`);
	assert.deepEqual(init.args, INIT_ARGS.split(" "), "init's arguments split on spaces, never globbed");
	// The shell's cd into HOME adds PWD and OLDPWD, as the provider's own start does.
	assert.deepEqual(Object.keys(init.env).sort(), ["AGENTRUN_COMPUTERD_SOCKET", "HOME", "OLDPWD", "PATH", "PWD"]);
	assert.equal(init.env.AGENTRUN_COMPUTERD_SOCKET, join(fixed.SOCKET_DIR[1], "computerd.sock"));
	assert.equal(init.cwd, fixed.HOME_DIR[1]);
	assert.ok(!JSON.stringify(init).includes(TOKEN.slice(4)), "the token is nowhere in init's start");
	const attach = calls.find((call) => call.command === "attach");
	assert.ok(attach, `attach started: ${JSON.stringify(calls)}`);
	assert.deepEqual(attach.args, []);
	assert.deepEqual(attach.env, { AGENTRUN_ATTACH_URL: env.AGENTRUN_ATTACH_URL, AGENTRUN_ATTACH_TOKEN: TOKEN });
	assert.ok(!stderr.includes(TOKEN.slice(4)), "nothing it says holds the token");
});

test("agentrun-dial gives a desktop's DISPLAY to init alone: attach's environment is the URL and token still", async (t) => {
	const { env, run } = await box(t);
	const { status, stderr, calls } = await run({ DISPLAY: ":0" });
	assert.equal(status, 0, stderr);
	const init = calls.find((call) => call.command === "init");
	assert.deepEqual(Object.keys(init.env).sort(), ["AGENTRUN_COMPUTERD_SOCKET", "DISPLAY", "HOME", "OLDPWD", "PATH", "PWD"]);
	assert.equal(init.env.DISPLAY, ":0");
	assert.deepEqual(calls.find((call) => call.command === "attach").env, { AGENTRUN_ATTACH_URL: env.AGENTRUN_ATTACH_URL, AGENTRUN_ATTACH_TOKEN: TOKEN });
});

test("agentrun-dial refuses a daemon whose sha256 is not the one it was given, before it runs anything, and removes it", async (t) => {
	const { fixed, run } = await box(t);
	const { status, stderr, calls } = await run({ AGENTRUN_DAEMON_SHA256: "0".repeat(64) });
	assert.equal(status, 4, stderr);
	assert.match(stderr, /reads sha256 [0-9a-f]{64}, not 0{64}, so nothing runs/);
	assert.deepEqual(calls, [], "neither init nor attach ran");
	assert.ok(!existsSync(fixed.DAEMON[1]) && !existsSync(`${fixed.DAEMON[1]}.part`), "and no daemon is left in place");
});

test("agentrun-dial runs nothing where /workspace is a link (exit 6), or init's arguments name no --user (exit 2)", async (t) => {
	const { dir, fixed, run } = await box(t);
	symlinkSync(dir, fixed.WORKSPACE[1]);
	const linked = await run();
	assert.equal(linked.status, 6, linked.stderr);
	assert.match(linked.stderr, /workspace was not made \d+:\d+'s/);
	assert.deepEqual(linked.calls, []);
	const userless = await run({ AGENTRUN_INIT_ARGS: "--deadline 2026-11-16T12:00:00Z --own-network" });
	assert.equal(userless.status, 2, userless.stderr);
	assert.match(userless.stderr, /names no --user/);
	assert.deepEqual(userless.calls, []);
});

test("agentrun-dial without the env a dial create sets exits 2, naming what is missing", async (t) => {
	const { run } = await box(t);
	for (const name of ["AGENTRUN_ATTACH_URL", "AGENTRUN_ATTACH_TOKEN", "AGENTRUN_DAEMON_URL", "AGENTRUN_DAEMON_SHA256", "AGENTRUN_INIT_ARGS"]) {
		const { status, stderr, calls } = await run({ [name]: "" });
		assert.equal(status, 2, name);
		assert.match(stderr, new RegExp(`${name} is not set`));
		assert.deepEqual(calls, []);
	}
});
