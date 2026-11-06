// Find, check and sweep computers on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): attach by id and by labels,
// list by label, network read-back, a drifted computer deleted at create, and the janitor deleting only the expired,
// stopped or running.
// Needs `npm run build` and `npm run build:daemon` first, Go on PATH (for the drifted daemon), and the images pulled.
// Every computer this file makes carries a label with this run's id; each is removed by its exact name in the after
// hook, pass or fail. The janitor sweeps only this run's label.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider, sweep } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const RUN_LABEL = "agentrun.test.run";
/** The uid of the provider's default user: this process's, or 1000 when this process's uid or gid is 0. */
const DEFAULT_UID = process.getuid() !== 0 && process.getgid() !== 0 ? String(process.getuid()) : "1000";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const exists = (name) => {
	try {
		execFileSync("docker", ["inspect", "--type", "container", name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

describe("find, check and sweep Docker computers", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const run = randomBytes(6).toString("hex");
	const made = [];
	const dirs = [];
	let provider;
	let arch;
	let a;
	let b;

	const ours = () => docker("ps", "-a", "--filter", `label=${RUN_LABEL}=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean).sort();
	const create = async (spec, using = provider) => {
		const created = await using.create({ lifetimeMs: 10 * 60_000, ...spec, labels: { [RUN_LABEL]: run, ...spec.labels } });
		if (created.ok) made.push(created.value.name);
		return created;
	};

	before(() => {
		arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
	});

	after(() => {
		for (const name of new Set([...made, ...ours()])) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("creates two computers with distinct labels: one with no network, one open", async () => {
		const first = await create({ image: "debian:bookworm-slim", network: "none", labels: { role: "a" } });
		assert.equal(first.ok, true, JSON.stringify(first));
		a = first.value;
		const second = await create({ image: "alpine:3.20", network: "open", labels: { role: "b" } });
		assert.equal(second.ok, true, JSON.stringify(second));
		b = second.value;
		assert.deepEqual(ours(), [a.name, b.name].sort());
	});

	it("attaches by name, by container id and by labels", async () => {
		assert.deepEqual(await provider.attach({ id: a.name }), { ok: true, value: a });
		assert.deepEqual(await provider.attach({ id: a.id }), { ok: true, value: a });
		assert.deepEqual(await provider.attach({ id: b.id.slice(0, 12) }), { ok: true, value: b });
		assert.deepEqual(await provider.attach({ labels: { [RUN_LABEL]: run, role: "b" } }), { ok: true, value: b });
		const both = await provider.attach({ labels: { [RUN_LABEL]: run } });
		assert.equal(both.ok, false);
		assert.equal(both.error.code, "invalid");
		assert.match(both.error.message, /2 computers match/);
		const none = await provider.attach({ labels: { [RUN_LABEL]: run, role: "c" } });
		assert.equal(none.ok, false);
		assert.equal(none.error.code, "not_found");
		const gone = await provider.attach({ id: "computer-000000000000" });
		assert.equal(gone.ok, false);
		assert.equal(gone.error.code, "not_found");
	});

	it("an attached computer connects and answers", async () => {
		const attached = await provider.attach({ labels: { [RUN_LABEL]: run, role: "a" } });
		assert.equal(attached.ok, true, JSON.stringify(attached));
		const connected = await provider.connect(attached.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		assert.equal(connected.value.hello.version, provider.version);
		assert.deepEqual(await connected.value.client.call("ping", {}), { ok: true, value: {} });
		await connected.value.close();
	});

	it("lists by label, with each computer's labels, deadline, state and network as read back", async () => {
		const listed = await provider.list({ [RUN_LABEL]: run });
		assert.equal(listed.ok, true, JSON.stringify(listed));
		const byRole = Object.fromEntries(listed.value.map((info) => [info.labels.role, info]));
		assert.deepEqual(Object.keys(byRole).sort(), ["a", "b"]);
		assert.deepEqual(byRole.a.ref, a);
		assert.deepEqual(byRole.b.ref, b);
		assert.equal(byRole.a.network, "none");
		assert.equal(byRole.b.network, "open");
		for (const info of listed.value) {
			assert.equal(info.state, "running");
			assert.equal(info.labels["agentrun.computer"], "1");
			assert.ok(info.deadline instanceof Date);
			assert.ok(info.deadline.getTime() > Date.now() && info.deadline.getTime() <= Date.now() + 10 * 60_000, info.deadline.toISOString());
		}
		const one = await provider.list({ [RUN_LABEL]: run, role: "b" });
		assert.deepEqual(one.value.map((info) => info.ref.name), [b.name]);
	});

	it("reads the network back, returns the same policy, and refuses any change, so the computer stays as it was", async () => {
		assert.deepEqual(await provider.network(a), { ok: true, value: "none" });
		assert.deepEqual(await provider.network(b), { ok: true, value: "open" });
		assert.deepEqual(await provider.network(a, "none"), { ok: true, value: "none" });
		const opened = await provider.network(a, "open");
		assert.equal(opened.ok, false);
		assert.equal(opened.error.code, "refused");
		assert.match(opened.error.message, /fixed at create; create a new computer/);
		const closed = await provider.network(b, "none");
		assert.equal(closed.ok, false);
		assert.equal(closed.error.code, "refused");
		assert.equal(docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", a.name).trim(), "none");
		assert.deepEqual(await provider.network(a), { ok: true, value: "none" });
		assert.deepEqual(await provider.network(b), { ok: true, value: "open" });
	});

	it("lists a stopped computer as stopped", async () => {
		assert.deepEqual(await provider.release(b, "stop"), { ok: true, value: undefined });
		const listed = await provider.list({ [RUN_LABEL]: run, role: "b" });
		assert.equal(listed.ok, true);
		assert.equal(listed.value[0].state, "stopped");
	});

	it("deletes a computer whose daemon reports another version, and says so", async () => {
		const dir = mkdtempSync(join(tmpdir(), "computer-drift-"));
		dirs.push(dir);
		chmodSync(dir, 0o755);
		const drifted = join(dir, "computerd");
		execFileSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${provider.version}-drift`, "-o", drifted, "./cmd/computerd"], {
			cwd: fileURLToPath(new URL("../../daemon", import.meta.url)),
			env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch },
			stdio: "ignore",
		});
		chmodSync(drifted, 0o755);
		const created = await create({ image: "debian:bookworm-slim", network: "none", labels: { role: "drift" } }, new DockerProvider({ daemonPath: drifted }));
		assert.equal(created.ok, false, JSON.stringify(created));
		assert.equal(created.error.code, "refused");
		assert.match(created.error.message, new RegExp(`version ${provider.version}-drift`));
		const name = created.error.message.match(/computer-[0-9a-f]{12}/)?.[0];
		assert.ok(name, created.error.message);
		assert.equal(exists(name), false, `${name} was deleted`);
		assert.deepEqual(ours(), [a.name, b.name].sort(), "nothing left with the drift label");
	});

	it("a full /work is No space left on device, not an OOM kill: PID 1 lives on and the next exec runs", async () => {
		const memoryMb = 256;
		const created = await create({ image: "debian:bookworm-slim", network: "none", memoryMb, labels: { role: "fill" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		const { name } = created.value;
		const tmpfs = JSON.parse(docker("inspect", "--format", "{{json .HostConfig.Tmpfs}}", name));
		assert.ok(tmpfs["/work"].split(",").includes(`size=${memoryMb / 2}m`), tmpfs["/work"]);
		assert.ok(tmpfs["/run/agentrun"].split(",").includes("size=1m"), tmpfs["/run/agentrun"]);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		const { client } = connected.value;
		try {
			const decode = (base64) => Buffer.from(base64 ?? "", "base64").toString("utf8");
			const fill = await client.call("exec.run", { argv: ["sh", "-c", `dd if=/dev/zero of="$HOME/fill" bs=1M count=${memoryMb + 64}`], timeoutMs: 120_000 });
			assert.equal(fill.ok, true, JSON.stringify(fill));
			assert.notEqual(fill.value.exitCode, 0, "dd cannot write more than /work holds");
			assert.match(decode(fill.value.stderr), /No space left on device/);
			const next = await client.call("exec.run", { argv: ["sh", "-c", 'id -u; df -m "$HOME" | tail -n 1'], timeoutMs: 60_000 });
			assert.equal(next.ok, true, JSON.stringify(next));
			assert.equal(next.value.exitCode, 0, decode(next.value.stderr));
			assert.equal(decode(next.value.stdout).split("\n")[0], DEFAULT_UID, "dd ran as the computer's user");
		} finally {
			await connected.value.close();
		}
		const [{ State: state }] = JSON.parse(docker("inspect", name));
		assert.equal(state.Running, true, "PID 1 is alive");
		assert.equal(state.OOMKilled, false, "nothing in the computer was OOM-killed");
		assert.deepEqual(await provider.release(created.value, "delete"), { ok: true, value: undefined });
	});

	it("the janitor deletes exactly the computers past their deadline: one that stopped itself, and one still running", async () => {
		const sweepLabel = { [RUN_LABEL]: run, sweep: "yes" };
		// Long enough for create's drift check on a loaded host; then init ends the computer and it stays, stopped.
		const short = await create({ image: "alpine:3.20", network: "none", lifetimeMs: 15_000, labels: { sweep: "yes", role: "short" } });
		assert.equal(short.ok, true, JSON.stringify(short));
		const mid = await create({ image: "alpine:3.20", network: "none", lifetimeMs: 5 * 60_000, labels: { sweep: "yes", role: "mid" } });
		assert.equal(mid.ok, true, JSON.stringify(mid));
		const long = await create({ image: "alpine:3.20", network: "none", labels: { sweep: "yes", role: "long" } });
		assert.equal(long.ok, true, JSON.stringify(long));
		const bound = Date.now() + 120_000;
		let state;
		do {
			[{ State: state }] = JSON.parse(docker("inspect", short.value.name));
			if (!state.Running) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		} while (Date.now() < bound);
		assert.equal(state.Running, false, "still running 120 s after a 15 s lifetime");
		assert.equal(state.ExitCode, 0);
		const listed = await provider.list(sweepLabel);
		assert.deepEqual(Object.fromEntries(listed.value.map((info) => [info.labels.role, info.state])), { short: "stopped", mid: "running", long: "running" });
		// mid's deadline is passed only for this sweep's now; long's is not.
		const swept = await sweep(provider, { labels: sweepLabel, now: new Date(Date.now() + 6 * 60_000) });
		assert.equal(swept.ok, true, JSON.stringify(swept));
		assert.deepEqual(swept.value.deleted.sort(), [short.value.name, mid.value.name].sort());
		assert.equal(swept.value.kept, 1);
		assert.equal(exists(short.value.name), false);
		assert.equal(exists(mid.value.name), false);
		assert.equal(exists(long.value.name), true);
		assert.equal(exists(a.name), true, "a computer outside the swept label is never touched");
		assert.deepEqual(await sweep(provider, { labels: sweepLabel }), { ok: true, value: { deleted: [], kept: 1 } });
	});
});
