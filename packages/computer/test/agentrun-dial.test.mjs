// agentrun-dial, the box image's entrypoint for a machine that dials the server (box/install.sh writes it), run here as
// this user against a copy whose fixed paths are a scratch directory's. The daemon it fetches is fake bytes from a local
// server: a stand-in that records each start, its arguments and its environment. No root, no network beyond loopback.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
const TOKEN = `art_${randomBytes(32).toString("base64url")}`;
/** init's user is this one: agentrun-dial gives /workspace to it, which only root may do for another. */
const USER = `${process.getuid()}:${process.getgid()}`;
const INIT_ARGS = `--deadline 2026-11-16T12:00:00Z --user ${USER} --own-network --network allow:*.example.com`;

/**
 * A scratch box: agentrun-dial with its fixed paths moved into it, the fake daemon's bytes, and a server for them.
 * fixed: more of its fixed values, by name, replaced. drops: which of agentrun-dial's requests the server resets before
 * answering, as a relay whose connection fails does: "none", "all", or "first try" (each one in the 500 ms after its
 * first; agentrun-dial waits 1 s before its next try). answers: the HTTP statuses its first answered requests get,
 * before the daemon's 200. fetches: its answered requests; dropped: how many it reset.
 */
async function box(t, { fixed: more = {}, drops = "none", answers = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computer-agentrun-dial-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = join(dir, "calls");
	// node itself runs it, with no shell between, so the environment it records is the one it was given.
	const daemon = Buffer.from(`#!${process.execPath}
const { appendFileSync } = require("node:fs");
const [command, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args, env: process.env, cwd: process.cwd(), pid: process.pid }) + "\\n");
if (command === "init" && require("node:fs").existsSync(${JSON.stringify(join(dir, "init-never-listens"))})) {
	setTimeout(() => process.exit(0), 20000);
} else if (command === "init") {
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
		...more,
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
	const hosts = [];
	const dropped = { count: 0, first: 0 };
	const server = createServer((req, res) => {
		// Other programs on a host may probe a new loopback port (a GET / with no token): only a request with this box's
		// token is agentrun-dial's.
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(404).end();
		dropped.first ||= Date.now();
		if (drops === "all" || (drops === "first try" && Date.now() - dropped.first < 500)) {
			dropped.count += 1;
			return req.socket.destroy();
		}
		fetches.push({ url: req.url, authorization: req.headers.authorization });
		hosts.push(req.headers.host);
		const status = answers[fetches.length - 1];
		if (status !== undefined) return res.writeHead(status).end(`status ${status}`);
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
			// A run that outlives 20 s is ended, so an unbounded loop fails its test instead of hanging the file.
			const child = spawn("sh", [join(dir, "agentrun-dial")], { cwd: dir, env: { ...env, ...overrides }, timeout: 20_000 });
			let stderr = "";
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => {
				const recorded = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
				resolve({ status, stderr, calls: recorded });
			});
		});
	return { dir, fixed, env, fetches, hosts, dropped, run };
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

test("agentrun-dial with AGENTRUN_ATTACH_EGRESS fetches the daemon through the relay, naming the URL's host, and gives attach the relay beside the URL and token; init gets none of it", async (t) => {
	const { env, fetches, hosts, run } = await box(t);
	// The URL names a host that resolves nowhere (.test, RFC 6761): the local server reached is the relay alone.
	const relay = `127.0.0.1:${new URL(env.AGENTRUN_DAEMON_URL).port}`;
	const { status, stderr, calls } = await run({ AGENTRUN_DAEMON_URL: "http://daemon.example.test/v2/computers/daemon?arch=amd64", AGENTRUN_ATTACH_EGRESS: relay });
	assert.equal(status, 0, stderr);
	assert.deepEqual(fetches, [{ url: "/v2/computers/daemon?arch=amd64", authorization: `Bearer ${TOKEN}` }]);
	assert.deepEqual(hosts, ["daemon.example.test"], "the request names the URL's host, never the relay");
	assert.deepEqual(Object.keys(calls.find((call) => call.command === "init").env).sort(), ["AGENTRUN_COMPUTERD_SOCKET", "HOME", "OLDPWD", "PATH", "PWD"]);
	assert.deepEqual(calls.find((call) => call.command === "attach").env, { AGENTRUN_ATTACH_URL: env.AGENTRUN_ATTACH_URL, AGENTRUN_ATTACH_TOKEN: TOKEN, AGENTRUN_ATTACH_EGRESS: relay });
});

test("agentrun-dial refuses an AGENTRUN_ATTACH_EGRESS of anything but digits, dots and colons (exit 2), before it fetches or runs anything", async (t) => {
	const { fetches, run } = await box(t);
	for (const egress of ["relay.example:18443", "192.0.2.40:18443 -k", "192.0.2.40:18443;id"]) {
		const { status, stderr, calls } = await run({ AGENTRUN_ATTACH_EGRESS: egress });
		assert.equal(status, 2, `${egress}: ${stderr}`);
		assert.match(stderr, /AGENTRUN_ATTACH_EGRESS is the relay's <IPv4>:<port>/);
		assert.deepEqual(calls, []);
	}
	assert.deepEqual(fetches, []);
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

test("agentrun-dial fetches the daemon after the first connection drops: it tries again, says so, and starts", async (t) => {
	const { dropped, fetches, run } = await box(t, { drops: "first try" });
	const { status, stderr, calls } = await run();
	assert.equal(status, 0, stderr);
	assert.ok(dropped.count >= 1, "the dropped request, then the one that served");
	assert.equal(fetches.length, 1);
	assert.equal(stderr.match(/trying again/g)?.length, 1, "one failed try, then the one that fetched");
	assert.ok(calls.some((call) => call.command === "init"), `init started: ${JSON.stringify(calls)}`);
	assert.match(stderr, /agentrun-dial: the daemon fetch's try 1 failed \(curl exit 5[256]\); trying again in 1 s/);
});

test("agentrun-dial tries a daemon route that answers 5xx again, and fetches it", async (t) => {
	const { fetches, run } = await box(t, { answers: [503] });
	const { status, stderr, calls } = await run();
	assert.equal(status, 0, stderr);
	assert.equal(fetches.length, 2);
	assert.ok(calls.some((call) => call.command === "init"));
});

test("a 4xx from the daemon route exits 7 at once, with one request: a refused token never works on a retry", async (t) => {
	const { fixed, fetches, run } = await box(t, { answers: [401, 401, 401] });
	const { status, stderr, calls } = await run();
	assert.equal(status, 7, stderr);
	assert.equal(fetches.length, 1, "one request");
	assert.match(stderr, /agentrun-dial: fetching the daemon from \S+ failed: the server answered HTTP 401/);
	assert.doesNotMatch(stderr, /trying again/);
	assert.deepEqual(calls, []);
	assert.ok(!existsSync(`${fixed.DAEMON[1]}.part`), "and the refusal's body is not left");
});

test("a connection that drops every time ends the fetch within its budget: exit 3, naming curl's exit and the tries", async (t) => {
	const { dropped, run } = await box(t, { drops: "all", fixed: { FETCH_S: ["45", "2"] } });
	const began = Date.now();
	const { status, stderr, calls } = await run();
	assert.equal(status, 3, stderr);
	assert.ok(Date.now() - began < 10_000, `bounded: ${Date.now() - began} ms`);
	assert.equal(stderr.match(/trying again/g)?.length, 1, "tried at once and after 1 s; a 2 s wait would pass the 2 s budget");
	assert.equal(dropped.count, 2, "two requests, one a try");
	assert.match(stderr, /agentrun-dial: fetching the daemon from \S+ failed: curl exit 5[256], after 2 tries/);
	assert.deepEqual(calls, []);
});

/** What still runs from a box: every stage of init's start (env, setsid, sh, the daemon) names the box's directory. */
const running = (dir) => {
	try {
		return execFileSync("pgrep", ["-f", dir], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
/** A TERM is delivered on its own time: what is left once a second has passed, or nothing. */
const leftAfterTerm = async (dir) => {
	for (let at = 0; at < 50 && running(dir); at++) await new Promise((resolve) => setTimeout(resolve, 20));
	return running(dir);
};
const SETSID = execFileSync("sh", ["-c", "command -v setsid"], { encoding: "utf8" }).trim();

test("an init that never listens is ended with agentrun-dial (exit 5), so a second start of agentrun-dial finds none running", async (t) => {
	const { dir, run } = await box(t, { fixed: { INIT_WAIT_TENTHS: ["300", "5"] } });
	writeFileSync(join(dir, "init-never-listens"), "");
	const { status, stderr } = await run();
	assert.equal(status, 5, stderr);
	assert.match(stderr, /init did not listen at \S+ within 0\.5 s/);
	assert.equal(await leftAfterTerm(dir), "", "nothing of init's start is left");
});

test("an init whose start the wait outran (setsid had not yet made its group) is ended by its pid: nothing of it runs later", async (t) => {
	// A setsid that waits 1 s first, ahead on agentrun-dial's PATH: the 0.5 s wait ends while init's start has no group
	// of its own. Its arguments name the box's daemon, so what runs of it is found by the box's directory still.
	const slow = mkdtempSync(join(tmpdir(), "computer-agentrun-dial-setsid-"));
	t.after(() => rmSync(slow, { recursive: true, force: true }));
	writeFileSync(join(slow, "setsid"), `#!/bin/sh\nsleep 1\nexec ${SETSID} "$@"\n`, { mode: 0o755 });
	const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
	const { dir, run } = await box(t, { fixed: { INIT_WAIT_TENTHS: ["300", "5"], PATH: [PATH, `${slow}:${PATH}`] } });
	writeFileSync(join(dir, "init-never-listens"), "");
	const { status, stderr } = await run();
	assert.equal(status, 5, stderr);
	assert.equal(await leftAfterTerm(dir), "", "the start was ended before setsid ran, so init never starts");
});
