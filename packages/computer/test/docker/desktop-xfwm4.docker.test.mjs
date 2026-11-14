// The window manager E2B's and Agent37's desktops run, started the way their providers start it, on the desktop of
// test/fixtures/desktop-xfwm4/Dockerfile (Debian trixie, as the Agent37 box). A program of the computer's user then reaches
// no unix socket but the computer's own: the isolation.vendor-agent check, run after create and again after
// apps.launch. computerd is PID 1 as on E2B and Agent37: `init --user 2510:2510 --own-network`, as root with the two
// capabilities a network namespace needs, DISPLAY set, and no passwd entry for 2510. The container has no seccomp
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
			built.value, DAEMON_IN_COMPUTER, "init", "--deadline", deadline, "--user", "2510:2510", "--own-network",
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
		// As a host whose facts say windowManager (E2B's, Agent37's): the display, then WINDOW_MANAGER on it.
		const started = await startDisplay(client, desktopOf({}), { version: VERSION, vendor: "docker", windowManager: true });
		assert.ok(started.ok, started.ok || started.error.message);
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

	// Review (#2787, PRRT_kwDOUmdVMs63e4QM): the user owns the window manager's user namespace, so a program of the user's
	// could join it, then its network namespace, and reach the bus by its abstract name. init's filter refuses setns.
	it("a program of the user cannot join the window manager's namespaces to reach its bus", async () => {
		const script = [
			'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in "xfwm4 "*) wm=${p#/proc/};; esac; done',
			'[ -n "$wm" ] || { echo "no xfwm4"; exit 9; }',
			'[ "$(readlink /proc/$wm/ns/net)" != "$(readlink /proc/self/ns/net)" ] || { echo "xfwm4 shares the user\'s network"; exit 9; }',
			"call='dbus-send --bus=unix:abstract=/agentrun/window-manager --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.GetId'",
			'$call && echo "outside: reached"',
			'nsenter --preserve-credentials -U -n -t "$wm" $call && echo "joined: reached"',
			"echo done",
		].join("\n");
		const ran = await client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 20_000 });
		assert.ok(ran.ok, JSON.stringify(ran));
		const out = Buffer.from(ran.value.stdout, "base64").toString();
		const err = Buffer.from(ran.value.stderr, "base64").toString();
		assert.match(out, /^done$/m, `the script ran through: ${out} ${err}`);
		assert.doesNotMatch(out, /reached/, `a program of the user reached the window manager's bus: ${out}`);
		assert.match(err, /nsenter: .*Operation not permitted/, `nsenter is refused (setns, EPERM): ${err}`);
	});

	it("after apps.launch of Mousepad, a program of the user still reaches none but the computer's own", async () => {
		const launched = await client.call("apps.launch", { id: "org.xfce.mousepad" }, { signal: AbortSignal.timeout(30_000) });
		assert.ok(launched.ok, JSON.stringify(launched));
		// What an app's bus starts, it starts within moments of the app's window: the keyring, an accessibility bus.
		await sleep(3_000);
		assert.deepEqual(await stray(), [], "a program of the computer's user connects to no socket but the computer's own");
	});
});
