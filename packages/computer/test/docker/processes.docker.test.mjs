// The processes demo on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only), as the default non-root user: a process
// started on one connection keeps running after it closes, and a second connection lists it, reads it by offset, types
// into it and signals it. Needs `npm run build` and `npm run build:daemon` first, and debian:bookworm-slim pulled. Every
// container this file makes is removed by its exact name in the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider, listProcesses, readAll } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
/** The provider's default user, which init and so every process runs as: this process's, or 1000:1000 as root. */
const DEFAULT_USER = process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
/** Bounds each wait on a program. The host may be loaded: it is never a claim about speed. */
const PATIENCE_MS = 30_000;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");
const b64 = (text) => Buffer.from(text).toString("base64");

describe("keep a process running across calls and connections in a Docker computer", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	const open = [];
	let provider;
	let ref;
	let b;
	let ticker;

	const connect = async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		open.push(connected.value);
		return connected.value;
	};
	const call = async (connection, method, params) => {
		const result = await connection.client.call(method, params);
		assert.equal(result.ok, true, `${method} ${JSON.stringify(params)}: ${JSON.stringify(result)}`);
		return result.value;
	};
	/** Reads a stream from offset until what was read holds want; returns it and where the stream now ends. */
	const readUntil = async (connection, id, stream, offset, want) => {
		let text = "";
		const end = Date.now() + PATIENCE_MS;
		while (Date.now() < end) {
			const read = await call(connection, "process.read", { id, stream, offset, waitMs: 1000 });
			text += decode(read.data);
			offset = read.nextOffset;
			if (text.includes(want)) return { text, offset };
			if (read.exited) break;
		}
		assert.fail(`${id} ${stream} never showed ${JSON.stringify(want)}: ${JSON.stringify(text)}`);
	};
	/** Waits until no process in the computer has one of these pids, as exec.run sees /proc. */
	const noneOf = async (connection, pids) => {
		const end = Date.now() + PATIENCE_MS;
		let left;
		do {
			const ran = await call(connection, "exec.run", {
				argv: ["sh", "-c", `for p in ${pids.join(" ")}; do [ -e /proc/$p ] && cat /proc/$p/stat; done; true`],
				timeoutMs: 20_000,
			});
			left = decode(ran.stdout).trim();
			if (left === "") return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		} while (Date.now() < end);
		assert.fail(`still running: ${left}`);
	};

	before(() => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
	});

	after(async () => {
		for (const connection of open) await connection.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
	});

	it("creates a computer with no network", async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "processes" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		ref = created.value;
		made.push(ref.name);
	});

	it("connection A starts a ticking loop and closes; the loop keeps running", async () => {
		const a = await connect();
		assert.deepEqual(a.hello.capabilities, ["exec", "files", "processes"]);
		ticker = await call(a, "process.start", { argv: ["sh", "-c", "i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.2; done"] });
		assert.match(ticker.id, /^p\d+$/);
		assert.ok(ticker.pid > 1, JSON.stringify(ticker));
		await readUntil(a, ticker.id, "stdout", 0, "tick 0");
		await a.close();
	});

	it("runs init and its processes as the non-root user, with the socket in a directory only that user may enter", async () => {
		const a = await connect();
		try {
			const ran = await call(a, "exec.run", {
				argv: ["sh", "-c", "id -u; id -g; stat -c '%a %u:%g %F' /run/agentrun /run/agentrun/computerd.sock; grep ' /run/agentrun ' /proc/mounts; grep '^Uid:' /proc/1/status"],
				timeoutMs: 20_000,
			});
			const [uid, gid, dir, socket, mount, init] = decode(ran.stdout).trim().split("\n");
			assert.equal(`${uid}:${gid}`, DEFAULT_USER);
			assert.notEqual(uid, "0");
			assert.equal(dir, `700 ${DEFAULT_USER} directory`);
			assert.equal(socket, `600 ${DEFAULT_USER} socket`);
			assert.match(mount, /^tmpfs \/run\/agentrun tmpfs /, mount);
			for (const option of ["rw", "nosuid", "nodev", "noexec"]) assert.ok(mount.split(" ")[3].split(",").includes(option), `${option} in ${mount}`);
			assert.match(init, new RegExp(`^Uid:\\t${uid}\\t${uid}\\t`), "PID 1, init, is the same user");
			const pid = await call(a, "exec.run", { argv: ["sh", "-c", `stat -c %u /proc/${ticker.pid}`], timeoutMs: 20_000 });
			assert.equal(decode(pid.stdout).trim(), uid, "the loop runs as the user too");
		} finally {
			await a.close();
		}
	});

	it("connection B lists it running, and reads it by offset with nextOffset growing", async () => {
		b = await connect();
		const listed = await listProcesses(b.client);
		assert.equal(listed.ok, true, JSON.stringify(listed));
		const list = listed.value;
		const entry = list.find((p) => p.id === ticker.id);
		assert.ok(entry, JSON.stringify(list));
		assert.equal(entry.running, true);
		assert.equal(entry.pid, ticker.pid);
		assert.deepEqual(entry.argv.slice(0, 2), ["sh", "-c"]);
		const first = await call(b, "process.read", { id: ticker.id, stream: "stdout", offset: 0 });
		assert.ok(first.nextOffset > 0);
		assert.match(decode(first.data), /^tick 0\n/);
		assert.equal(first.dropped, 0);
		const { offset } = await readUntil(b, ticker.id, "stdout", first.nextOffset, "tick");
		assert.ok(offset > first.nextOffset, `${offset} after ${first.nextOffset}`);
		const { offset: later } = await readUntil(b, ticker.id, "stdout", offset, "tick");
		assert.ok(later > offset, `${later} after ${offset}`);
	});

	it("gives a cat process its stdin, then closes it", async () => {
		const cat = await call(b, "process.start", { argv: ["cat"], stdin: true });
		await call(b, "process.write", { id: cat.id, data: b64("hello from B\n") });
		await call(b, "process.write", { id: cat.id, data: b64("bye\n"), close: true });
		assert.deepEqual(await call(b, "process.wait", { id: cat.id, timeoutMs: PATIENCE_MS }), { running: false, exitCode: 0, signal: null });
		const read = await readAll(b.client, cat.id, "stdout");
		assert.equal(read.ok, true, JSON.stringify(read));
		assert.equal(Buffer.from(read.value.data).toString(), "hello from B\nbye\n");
	});

	it("runs sh in a pty: it echoes a command, and stty size follows a resize", async () => {
		const sh = await call(b, "process.start", { argv: ["sh"], pty: { cols: 80, rows: 24 } });
		let offset = 0;
		await call(b, "process.write", { id: sh.id, data: b64("echo pty-$((6*7))\n") });
		({ offset } = await readUntil(b, sh.id, "pty", offset, "pty-42"));
		await call(b, "process.write", { id: sh.id, data: b64("tty; stty size\n") });
		({ offset } = await readUntil(b, sh.id, "pty", offset, "24 80"));
		await call(b, "process.resize", { id: sh.id, cols: 132, rows: 43 });
		await call(b, "process.write", { id: sh.id, data: b64("stty size\n") });
		({ offset } = await readUntil(b, sh.id, "pty", offset, "43 132"));
		await call(b, "process.write", { id: sh.id, data: b64("exit 5\n") });
		assert.deepEqual(await call(b, "process.wait", { id: sh.id, timeoutMs: PATIENCE_MS }), { running: false, exitCode: 5, signal: null });
	});

	it("signals TERM to the loop, and wait reports TERM", async () => {
		await call(b, "process.signal", { id: ticker.id, signal: "TERM" });
		assert.deepEqual(await call(b, "process.wait", { id: ticker.id, timeoutMs: PATIENCE_MS }), { running: false, exitCode: null, signal: "TERM" });
		const { processes, truncated } = await call(b, "process.list", {});
		assert.equal(truncated, false);
		const entry = processes.find((p) => p.id === ticker.id);
		assert.equal(entry.running, false);
		assert.equal(entry.signal, "TERM");
		assert.ok(entry.endedAt >= entry.startedAt);
		await noneOf(b, [ticker.pid]);
	});

	it("leaves no survivor when a process SIGKILLs its own guard", async () => {
		const rogue = await call(b, "process.start", { argv: ["sh", "-c", "sleep 305 & echo $$ $!; kill -9 $PPID; wait"] });
		const { text } = await readUntil(b, rogue.id, "stdout", 0, "\n");
		const pids = text.trim().split(/\s+/).map(Number);
		assert.equal(pids.length, 2, text);
		assert.equal(pids[0], rogue.pid);
		const waited = await call(b, "process.wait", { id: rogue.id, timeoutMs: PATIENCE_MS });
		assert.equal(waited.running, false);
		await noneOf(b, pids);
	});

	it("stops the computer with a process running: the daemon as PID 1 exits 0, not 137", async () => {
		await call(b, "process.start", { argv: ["sh", "-c", "trap '' TERM; sleep 600"] });
		for (const connection of open.splice(0)) await connection.close();
		assert.deepEqual(await provider.release(ref, "stop"), { ok: true, value: undefined });
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		assert.equal(inspected.State.Running, false);
		assert.equal(inspected.State.ExitCode, 0);
	});

	it("ends at its deadline with a process that ignores TERM still running: init ends every process and exits 0", async () => {
		// Long enough to connect and start the process on a loaded host; the test asserts the end, not its timing.
		const created = await provider.create({ image: IMAGE, lifetimeMs: 15_000, network: "none", labels: { "agentrun.test": "processes" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		open.push(connected.value);
		await call(connected.value, "process.start", { argv: ["sh", "-c", "trap '' TERM; sleep 600"] });
		const bound = Date.now() + 120_000;
		let state;
		do {
			[{ State: state }] = JSON.parse(docker("inspect", created.value.name));
			if (!state.Running) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		} while (Date.now() < bound);
		assert.equal(state.Running, false, "still running 120 s after a 15 s lifetime");
		assert.equal(state.ExitCode, 0, "init ended the computer, not Docker's SIGKILL");
		assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	});

	it("deletes the computer", async () => {
		assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
		assert.equal(docker("ps", "-a", "--filter", `name=^${ref.name}$`, "--format", "{{.Names}}").trim(), "");
	});
});
