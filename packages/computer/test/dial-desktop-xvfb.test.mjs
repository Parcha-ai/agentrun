// A dial desktop against a real computerd and a real Xvfb on this host: init started with DISPLAY, as agentrun-dial starts
// it for a desktop, in a user namespace of its own (unshare -Ur); its socket handed to an AttachHub as a machine minted a
// desktop, one frame a line, as `computerd attach` carries it; the X server and the window manager started through
// computerd's process.start over that connection (desktop.ts startDisplay); then hello says desktop and the screen tools
// answer. Skipped, in words, where the host has no dist/computerd-linux-<arch> (npm run build:daemon), no Xvfb, or
// refuses a user namespace. No window manager: its own unshare --user, nested in this test's user namespace, may not
// write its uid map; hosted-dial.test.mjs drives the provider's create, the window manager among it, over the fake dial host.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AttachHub, helloMismatch, mintedComputer } from "../dist/index.js";
import { desktopOf, startDisplay } from "../dist/desktop.js";

const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
const DAEMON = fileURLToPath(new URL(`../dist/computerd-linux-${ARCH}`, import.meta.url));
const has = (program) => spawnSync("sh", ["-c", `command -v ${program}`]).status === 0;
const userns = spawnSync("unshare", ["-Ur", "unshare", "-n", "true"]).status === 0;
const skip = !existsSync(DAEMON) ? `needs ${DAEMON}: npm run build:daemon` : !has("Xvfb") ? "needs Xvfb" : !userns ? "needs a user namespace with its capabilities (unshare -Ur), which this host refuses" : false;
/** A display no X server on this host holds. */
const free = () => {
	for (let n = 90; n < 200; n++) if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return `:${n}`;
	throw new Error("no free X display from :90 to :199");
};
const MACHINE = "computer-5f3a9c1e7b2d";

/** A unix socket as an AttachSocket: each line in is a frame, each frame out a line. */
function lineSocket(stream) {
	const texts = [];
	const closes = [];
	let buffered = "";
	let closed = false;
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffered += chunk;
		for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
			const line = buffered.slice(0, at);
			buffered = buffered.slice(at + 1);
			for (const listener of texts) listener(line);
		}
	});
	const ended = (code, reason) => {
		if (closed) return;
		closed = true;
		for (const listener of closes) listener(code, reason);
	};
	stream.on("close", () => ended(1006, "the socket closed"));
	return {
		send: (text) => void stream.write(`${text}\n`),
		close(code, reason) {
			stream.destroy();
			ended(code, reason);
		},
		onText: (listener) => void texts.push(listener),
		onClose: (listener) => void closes.push(listener),
	};
}

describe("a dial desktop against computerd and Xvfb on this host", { skip }, () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-dial-desktop-"));
	const socket = join(dir, "computerd.sock");
	const display = free();
	const hub = new AttachHub({ helloMs: 5_000 });
	const minted = mintedComputer(MACHINE, { kind: "desktop", os: "linux", arch: ARCH });
	let init;
	let stderr = "";
	const pids = [];

	before(async () => {
		const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
		init = spawn("unshare", ["-Ur", DAEMON, "init", "--deadline", deadline], { env: { PATH: process.env.PATH, AGENTRUN_COMPUTERD_SOCKET: socket, DISPLAY: display }, stdio: ["ignore", "ignore", "pipe"] });
		init.stderr.on("data", (chunk) => (stderr += chunk));
		for (let tries = 0; !existsSync(socket); tries++) {
			assert.ok(tries < 200 && init.exitCode === null, `computerd's init did not listen at ${socket}: ${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	});

	after(async () => {
		if (init && init.exitCode === null) {
			const ended = new Promise((resolve) => init.once("exit", resolve));
			init.kill("SIGTERM");
			await ended;
		}
		// init ends its programs with it; any it left is ended here, so no X server outlives the test.
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("the hub takes the minted desktop's socket while it says linux, the display comes up over it, and the screen tools answer", { timeout: 60_000 }, async () => {
		const stream = connect(socket);
		await new Promise((resolve, reject) => stream.once("connect", resolve).once("error", reject));
		const accepted = await hub.accept(minted, lineSocket(stream));
		assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.error.message);
		assert.equal(accepted.value.kind, "linux", "no display answers before the X server starts");
		const connection = hub.connection(MACHINE);
		assert.ok(connection, "the hub holds the socket under the machine's name");

		const shown = await startDisplay(connection.client, desktopOf({ display }), { version: "0.0.0-test", vendor: "test" });
		const listed = await connection.client.call("process.list", {});
		if (listed.ok) for (const one of listed.value.processes) pids.push(one.pid);
		assert.equal(shown.ok, true, shown.ok ? "" : `${shown.error.message}; init: ${stderr}`);
		assert.deepEqual(
			listed.value.processes.map(({ argv }) => argv[0]),
			["Xvfb"],
			"computerd started the X server",
		);

		const hello = await connection.client.call("hello", { client: "test" });
		assert.equal(hello.ok, true);
		assert.equal(hello.value.kind, "desktop");
		assert.equal(hello.value.display, display);
		for (const group of ["screen", "input.pointer", "input.keys"]) assert.ok(hello.value.groups.includes(group), group);
		assert.equal(helloMismatch(minted, hello.value), undefined, "a redial now matches its mint");

		const shot = await connection.client.call("screen.shot", {});
		assert.equal(shot.ok, true, shot.ok ? "" : shot.error.message);
		assert.equal(Buffer.from(shot.value.data, "base64").subarray(1, 4).toString(), "PNG");
		const click = await connection.client.call("input.actions", { actions: [{ type: "click", at: [10, 10] }] });
		assert.equal(click.ok, true, click.ok ? "" : click.error.message);
		assert.deepEqual(click.value, { done: 1 });
		await connection.close();
	});
});
