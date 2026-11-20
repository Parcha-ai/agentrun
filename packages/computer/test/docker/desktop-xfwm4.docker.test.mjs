// The window manager E2B's and Agent37's desktops run, started the way their providers start it, on the desktop of
// test/fixtures/desktop-xfwm4/Dockerfile (Debian trixie, as the Agent37 box). A program of the computer's user then reaches
// no unix socket but the computer's own: the isolation.vendor-agent check, run after create and again after
// apps.launch. A program of the user still makes namespaces of its own and joins them. computerd is PID 1 as on E2B and
// Agent37: `init --user 2510:2510 --own-network --window-manager`, as root with the two capabilities a network namespace
// needs, DISPLAY set, and no passwd entry for 2510; computerd starts the manager, and create waits on hello's
// windowManager. The container has no seccomp
// profile, because Docker's default refuses a user namespace to a process with no capabilities, and E2B's and Agent37's
// kernels allow one. AGENTRUN_COMPUTER_LIVE_DOCKER=1 only; needs `npm run build` and `npm run build:daemon`. The image is
// built with ensureImage; the container is named computer-xfwm4-<hex> and removed by that name.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import "./teardown.mjs";
import { DaemonClient, ensureImage } from "../../dist/index.js";
import { OWN_SOCKETS } from "../../dist/conformance/cases/isolation.js";
import { desktopOf, startDisplay } from "../../dist/desktop.js";
import { DAEMON_IN_COMPUTER } from "../../dist/drift.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const DOCKERFILE = fileURLToPath(new URL("../fixtures/desktop-xfwm4/Dockerfile", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
/** The display's socket by its path and by its abstract name: one X server, the computer's own. */
const DISPLAY_SOCKETS = ["/tmp/.X11-unix/X0", "@/tmp/.X11-unix/X0"];

describe("xfwm4 as E2B and Agent37 start it", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const name = `computer-xfwm4-${randomBytes(6).toString("hex")}`;
	const children = [];
	let client;

	before(async () => {
		const built = await ensureImage({ recipe: readFileSync(DOCKERFILE, "utf8") });
		assert.ok(built.ok, built.ok || built.error.message);
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemon = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		const deadline = new Date(Date.now() + 600_000).toISOString();
		docker(
			"run", "--detach", "--name", name, "--network", "none", "--user", "0:0",
			"--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", "--security-opt", "seccomp=unconfined",
			"--env", "DISPLAY=:0", "--env", "HOME=/work", "--volume", `${daemon}:${DAEMON_IN_COMPUTER}:ro`,
			built.value, DAEMON_IN_COMPUTER, "init", "--deadline", deadline, "--user", "2510:2510", "--own-network", "--window-manager",
		);
		const until = Date.now() + 30_000;
		for (;;) {
			const child = spawn("docker", ["exec", "-i", name, DAEMON_IN_COMPUTER, "stdio"], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
			const hello = await client.call("hello", { client: "desktop-xfwm4 test" }, { signal: AbortSignal.timeout(10_000) });
			if (hello.ok) break;
			client.close();
			child.kill("SIGKILL");
			if (Date.now() > until) assert.fail(`init did not answer hello within 30 s: ${JSON.stringify(hello)}; logs: ${spawnSync("docker", ["logs", name], { encoding: "utf8" }).stderr}`);
			await sleep(300);
		}
		// As a host whose facts say windowManager (E2B's, Agent37's): the display, then the wait on computerd's manager.
		const started = await startDisplay(client, desktopOf({}), { version: VERSION, vendor: "docker" });
		assert.ok(started.ok, started.ok || started.error.message);
		const hello = await client.call("hello", { client: "desktop-xfwm4 test" });
		assert.deepEqual(hello.ok && hello.value.windowManager, { state: "running" }, "computerd says its window manager runs");
	});

	after(() => {
		client?.close();
		for (const child of children) child.kill("SIGKILL");
		spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	});

	/** The unix sockets a program of the computer's user connects to, less the computer's own: computerd's probe, as the case runs it. */
	async function stray() {
		const ran = await client.call("exec.run", { argv: [DAEMON_IN_COMPUTER, "probe", "--sockets"], timeoutMs: 30_000 });
		assert.ok(ran.ok, JSON.stringify(ran));
		const { sockets } = JSON.parse(Buffer.from(ran.value.stdout, "base64").toString());
		assert.deepEqual(sockets.incomplete, [], "the probe searched every place a socket may be");
		const own = [...OWN_SOCKETS, ...DISPLAY_SOCKETS];
		return sockets.sockets.filter(({ path }) => !own.includes(path)).map(({ path, type }) => `${path} (${type})`);
	}

	it("runs, and frames the display: a program of the user reaches none of its sockets", async () => {
		const wm = await client.call("exec.run", { argv: ["sh", "-c", "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done"], timeoutMs: 10_000 });
		assert.ok(wm.ok, JSON.stringify(wm));
		assert.match(Buffer.from(wm.value.stdout, "base64").toString(), /^xfwm4 /m, "xfwm4 runs");
		assert.deepEqual(await stray(), [], "a program of the computer's user connects to no socket but the computer's own");
	});

	// The bus's activation leaves xfconfd an orphan. The manager's start reaps its orphans, so xfconfd stays under
	// dbus-run-session; one handed to init would be killed by init's sweep, and xfwm4 would wait on a new one at every read.
	// xfwm4 has the bus start xfconfd at its first settings read, which may come after hello says it runs: read for 10 s.
	it("keeps the xfconfd its bus started under the manager's start, out of init's sweep", async () => {
		const script = 'for p in /proc/[0-9]*; do printf "%s %s %s\\n" "${p#/proc/}" "$(awk \'/^PPid:/ {print $2}\' $p/status)" "$(tr "\\0" " " < $p/cmdline | cut -d" " -f1)"; done';
		let rows;
		for (const until = Date.now() + 10_000; ; await sleep(250)) {
			const ran = await client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 10_000 });
			assert.ok(ran.ok, JSON.stringify(ran));
			rows = Buffer.from(ran.value.stdout, "base64").toString().trim().split("\n").map((line) => line.split(" "));
			if (rows.some(([, , argv0]) => argv0.endsWith("/xfconfd")) || Date.now() > until) break;
		}
		const session = rows.find(([, , argv0]) => argv0 === "dbus-run-session");
		const xfconfd = rows.find(([, , argv0]) => argv0.endsWith("/xfconfd"));
		assert.ok(session && xfconfd, `dbus-run-session and xfconfd run: ${JSON.stringify(rows)}`);
		assert.equal(xfconfd[1], session[0], "xfconfd's parent is the manager's dbus-run-session, not init");
	});

	// computerd made the window manager's network namespace as root, so it is of the computer's own user namespace, where
	// the user holds no capability: a program of the user's can't join it (setns needs CAP_SYS_ADMIN over it), and reaches
	// the bus by its abstract name neither from its own namespace nor by nsenter. xfwm4 runs as the user, uid 2510.
	it("a program of the user can't reach the window manager's bus, from its own network namespace or by joining xfwm4's", async () => {
		const script = [
			'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in "xfwm4 "*) wm=${p#/proc/};; esac; done',
			'[ -n "$wm" ] || { echo "no xfwm4"; exit 9; }',
			'[ "$(readlink /proc/$wm/ns/net)" != "$(readlink /proc/self/ns/net)" ] || { echo "xfwm4 shares the user\'s network"; exit 9; }',
			'[ "$(readlink /proc/$wm/ns/user)" = "$(readlink /proc/self/ns/user)" ] && echo "same user namespace"',
			'echo "uid $(awk \'/^Uid:/ {print $2}\' /proc/$wm/status)"',
			"call='dbus-send --bus=unix:abstract=/agentrun/window-manager --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.GetId'",
			'$call > /dev/null && echo "outside: reached"',
			'nsenter --preserve-credentials -n -t "$wm" $call > /dev/null && echo "joined: reached"',
			"echo done",
		].join("\n");
		const ran = await client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 20_000 });
		assert.ok(ran.ok, JSON.stringify(ran));
		const out = Buffer.from(ran.value.stdout, "base64").toString();
		const err = Buffer.from(ran.value.stderr, "base64").toString();
		assert.match(out, /^done$/m, `the script ran through: ${out} ${err}`);
		assert.match(out, /^same user namespace$/m, `xfwm4 runs in no user namespace of its own: ${out}`);
		assert.match(out, /^uid 2510$/m, `xfwm4 runs as the computer's user: ${out}`);
		assert.doesNotMatch(out, /outside: reached/, `a program of the user reached the window manager's bus from its own namespace: ${out}`);
		assert.doesNotMatch(out, /joined: reached/, `a program of the user joined xfwm4's network namespace and reached its bus: ${out} ${err}`);
	});

	// Rootless containers, nsenter and `ip netns exec` make namespaces of the user's and join them: init's filter lets
	// setns through.
	it("a program of the user makes a user and network namespace of its own (unshare -Urn) and joins them (nsenter)", async () => {
		const script = String.raw`
unshare -Urn sleep 30 & made=$!
for i in $(seq 100); do [ "$(readlink /proc/$made/ns/net)" != "$(readlink /proc/self/ns/net)" ] && break; sleep 0.1; done
echo "self $(readlink /proc/self/ns/user) $(readlink /proc/self/ns/net)"
echo "made $(readlink /proc/$made/ns/user) $(readlink /proc/$made/ns/net)"
nsenter --preserve-credentials -U -n -t "$made" sh -c 'echo "joined $(readlink /proc/self/ns/user) $(readlink /proc/self/ns/net)"'
kill $made`;
		const ran = await client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 20_000 });
		assert.ok(ran.ok, JSON.stringify(ran));
		const out = Buffer.from(ran.value.stdout, "base64").toString();
		const err = Buffer.from(ran.value.stderr, "base64").toString();
		const line = (label) => out.match(new RegExp(`^${label} (.+)$`, "m"))?.[1];
		assert.ok(line("made") && line("self"), `the script ran: ${out} ${err}`);
		const [self, made] = [line("self").split(" "), line("made").split(" ")];
		assert.ok(made[0] !== self[0] && made[1] !== self[1], `unshare -Urn made a user and a network namespace: ${out} ${err}`);
		assert.equal(line("joined"), line("made"), `nsenter joined them: ${out} ${err}`);
	});

	it("after apps.launch of Mousepad, a program of the user still reaches none but the computer's own", async () => {
		const launched = await client.call("apps.launch", { id: "org.xfce.mousepad" }, { signal: AbortSignal.timeout(30_000) });
		assert.ok(launched.ok, JSON.stringify(launched));
		// What an app's bus starts, it starts within moments of the app's window: the keyring, an accessibility bus.
		await sleep(3_000);
		assert.deepEqual(await stray(), [], "a program of the computer's user connects to no socket but the computer's own");
	});
});
