// What only Docker names of a computer, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): attach by the container's
// name and by its id or a 12-digit prefix of it, a computer's name that no container has, the host's enforcement from
// docker info, attach refusing (and leaving) a computer made with another daemon, and a create aborted right after
// docker run (held there by a docker CLI wrapper) leaving nothing; and a full /work is ENOSPC, not an OOM kill.
// Attach by id and labels, list, network read-back, release, the drift check and the janitor are in the conformance
// suite (conformance.docker.test.mjs). Needs `npm run build` and `npm run build:daemon` first, and alpine:3.20 pulled. Every
// computer this file makes carries a label with this run's id and is removed by its exact name in the after hook.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const RUN_LABEL = "agentrun.test.run";
/** The uid of the provider's default user: this process's, or 1000 when this process's uid or gid is 0. */
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const exists = (name) => {
	try {
		execFileSync("docker", ["inspect", "--type", "container", name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

describe("attach to a Docker computer by Docker's names for it", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const run = randomBytes(6).toString("hex");
	const made = [];
	const dirs = [];
	let provider;
	let daemonPath;
	let arch;
	let ref;

	const ours = () => docker("ps", "-a", "--filter", `label=${RUN_LABEL}=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean);

	before(async () => {
		arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
		const created = await provider.create({ image: "alpine:3.20", lifetimeMs: 10 * 60_000, network: "none", labels: { [RUN_LABEL]: run } });
		assert.equal(created.ok, true, JSON.stringify(created));
		ref = created.value;
		made.push(ref.name);
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

	it("attaches by the container's name, its whole id and its first 12 digits", async () => {
		assert.match(ref.name, /^computer-[0-9a-f]{12}$/);
		assert.match(ref.id, /^[0-9a-f]{64}$/);
		for (const id of [ref.name, ref.id, ref.id.slice(0, 12)]) {
			const attached = await provider.attach({ id });
			assert.equal(attached.ok, true, JSON.stringify(attached));
			assert.deepEqual({ id: attached.value.id, name: attached.value.name }, ref, id);
			assert.equal(attached.value.spec.network, "none", id);
			assert.equal(attached.value.spec.image, "alpine:3.20", id);
			assert.match(attached.value.spec.user, /^\d+:\d+$/, id);
			assert.notEqual(attached.value.spec.user.split(":")[0], "0", `${id}: the provider's default user is not root`);
			assert.equal(attached.value.spec.kind, "linux", `${id}: the kind its daemon's hello reports`);
		}
	});

	it("attach to a computer that asked for root reports user 0:0, with its network, image and sizes", async () => {
		const created = await provider.create({ image: "alpine:3.20", lifetimeMs: 10 * 60_000, network: "none", user: "0", memoryMb: 256, labels: { [RUN_LABEL]: run, role: "root" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		for (const target of [{ id: created.value.name }, { labels: { [RUN_LABEL]: run, role: "root" } }]) {
			const attached = await provider.attach(target);
			assert.equal(attached.ok, true, JSON.stringify(attached));
			const { spec } = attached.value;
			assert.deepEqual([spec.user, spec.network, spec.image, spec.memoryMb, spec.cpus, spec.pids, spec.workdir], ["0:0", "none", "alpine:3.20", 256, 2, 1024, "/work"]);
			assert.ok(spec.deadline instanceof Date && spec.deadline.getTime() > Date.now(), String(spec.deadline));
		}
		docker("rm", "--force", "--volumes", created.value.name);
	});

	it("reads the Docker host's enforcement: every limit, and seccomp", async () => {
		const host = await provider.host();
		assert.equal(host.ok, true, JSON.stringify(host));
		assert.deepEqual(host.value.problems, []);
		assert.equal(host.value.arch, arch);
		const options = JSON.parse(docker("info", "--format", "{{json .SecurityOptions}}"));
		assert.equal(host.value.apparmor, options.some((option) => option.startsWith("name=apparmor")));
		assert.equal(host.value.selinux, options.some((option) => option.startsWith("name=selinux")));
	});

	it("attach refuses a computer that drifts from this provider, by name and by labels, and leaves it running", async () => {
		const dir = mkdtempSync(join(tmpdir(), "computer-other-"));
		dirs.push(dir);
		chmodSync(dir, 0o755);
		const other = join(dir, "computerd");
		copyFileSync(daemonPath, other);
		// Another daemon is other bytes: the provider binds a copy named by their sha256, so the same bytes from another
		// path are the same daemon. A byte past the end of the ELF file changes the hash and nothing it runs.
		appendFileSync(other, "\n");
		chmodSync(other, 0o755);
		const created = await new DockerProvider({ daemonPath: other }).create({
			image: "debian:bookworm-slim",
			lifetimeMs: 10 * 60_000,
			network: "none",
			labels: { [RUN_LABEL]: run, role: "other" },
		});
		assert.equal(created.ok, true, JSON.stringify(created));
		const { name } = created.value;
		made.push(name);
		const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
		const [inspected] = JSON.parse(docker("inspect", name));
		const otherCopy = inspected.Mounts.find((mount) => mount.Destination === "/opt/agentrun/computerd").Source;
		assert.equal(basename(otherCopy), `computerd-${sha(other)}`, "the other provider bound its copy of the other daemon");
		for (const target of [{ id: name }, { labels: { [RUN_LABEL]: run, role: "other" } }]) {
			const attached = await provider.attach(target);
			assert.equal(attached.ok, false, JSON.stringify(attached));
			assert.equal(attached.error.code, "refused");
			assert.ok(attached.error.message.includes(name), attached.error.message);
			assert.match(attached.error.message, new RegExp(`daemon mount: declared \\S*/computerd-${sha(daemonPath)} bound read-only`), attached.error.message);
			assert.ok(attached.error.message.includes(otherCopy), attached.error.message);
		}
		assert.equal(docker("inspect", "--format", "{{.State.Running}}", name).trim(), "true", "attach did not make it, so it leaves it");
		docker("rm", "--force", "--volumes", name);
		assert.deepEqual(ours(), [ref.name]);
	});

	it("a computer's name no container has is not_found", async () => {
		const gone = await provider.attach({ id: "computer-000000000000" });
		assert.equal(gone.ok, false);
		assert.equal(gone.error.code, "not_found");
	});
	it("a create aborted right after docker run returns aborted, and nothing with its label is left", async () => {
		// A docker CLI that holds create's first inspect, the step right after run, until the test says go.
		const dir = mkdtempSync(join(tmpdir(), "computer-abort-"));
		dirs.push(dir);
		const held = join(dir, "held");
		const go = join(dir, "go");
		const wrapper = join(dir, "docker");
		writeFileSync(
			wrapper,
			`#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const run = () => process.exit(spawnSync("docker", args, { stdio: "inherit" }).status ?? 1);
if (args[0] !== "inspect" || existsSync(${JSON.stringify(go)})) run();
writeFileSync(${JSON.stringify(held)}, "");
const bound = Date.now() + 120_000;
setInterval(() => (existsSync(${JSON.stringify(go)}) || Date.now() > bound) && run(), 50);
`,
			{ mode: 0o755 },
		);
		const holding = new DockerProvider({ daemonPath, docker: wrapper });
		const controller = new AbortController();
		const pending = holding.create(
			{ image: "alpine:3.20", network: "none", lifetimeMs: 10 * 60_000, labels: { [RUN_LABEL]: run, role: "abort" } },
			{ signal: controller.signal },
		);
		const bound = Date.now() + 120_000;
		while (!existsSync(held)) {
			assert.ok(Date.now() < bound, "create never reached the inspect after docker run");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const name = docker("ps", "-a", "--filter", `label=${RUN_LABEL}=${run}`, "--filter", "label=role=abort", "--format", "{{.Names}}").trim();
		assert.match(name, /^computer-[0-9a-f]{12}$/, "docker run made the computer before the abort");
		controller.abort();
		writeFileSync(go, "");
		const created = await pending;
		if (created.ok) made.push(created.value.name);
		assert.equal(created.ok, false, JSON.stringify(created));
		assert.equal(created.error.code, "aborted");
		assert.match(created.error.message, new RegExp(`${name} was deleted`));
		assert.equal(exists(name), false, `${name} was deleted`);
		assert.equal(docker("ps", "-a", "--filter", `label=${RUN_LABEL}=${run}`, "--filter", "label=role=abort", "--format", "{{.Names}}").trim(), "");
	});
});

describe("a Docker computer's /work is bounded", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const run = randomBytes(6).toString("hex");
	const made = [];
	/** The provider's default uid: this process's, or 1000 when its uid or gid is 0. */
	const DEFAULT_UID = String(process.getuid() !== 0 && process.getgid() !== 0 ? process.getuid() : 1000);
	const decode = (base64) => Buffer.from(base64 ?? "", "base64").toString("utf8");
	let provider;

	before(() => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
	});

	after(() => {
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed by the test.
			}
		}
	});

	it("a full /work is No space left on device, not an OOM kill: PID 1 lives on and the next exec runs", async () => {
		const memoryMb = 256;
		const created = await provider.create({ image: "debian:bookworm-slim", lifetimeMs: 10 * 60_000, network: "none", memoryMb, labels: { [RUN_LABEL]: run, role: "fill" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		const { name } = created.value;
		made.push(name);
		const tmpfs = JSON.parse(docker("inspect", "--format", "{{json .HostConfig.Tmpfs}}", name));
		assert.ok(tmpfs["/work"].split(",").includes(`size=${memoryMb / 2}m`), tmpfs["/work"]);
		assert.ok(tmpfs["/run/agentrun"].split(",").includes("size=1m"), tmpfs["/run/agentrun"]);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		const { client } = connected.value;
		try {
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

});
