// What only Docker names of a computer, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): attach by the container's
// name and by its id or a 12-digit prefix of it, and a computer's name that no container has. Attach by id and labels,
// list, network read-back, release, the drift check and the janitor are in the conformance suite
// (conformance.docker.test.mjs). Needs `npm run build` and `npm run build:daemon` first, and alpine:3.20 pulled. Every
// computer this file makes carries a label with this run's id and is removed by its exact name in the after hook.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const RUN_LABEL = "agentrun.test.run";
/** The uid of the provider's default user: this process's, or 1000 when this process's uid or gid is 0. */
const DEFAULT_UID = process.getuid() !== 0 && process.getgid() !== 0 ? String(process.getuid()) : "1000";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });

describe("attach to a Docker computer by Docker's names for it", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const run = randomBytes(6).toString("hex");
	const made = [];
	let provider;
	let ref;

	const ours = () => docker("ps", "-a", "--filter", `label=${RUN_LABEL}=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean);

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
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
	});

	it("attaches by the container's name, its whole id and its first 12 digits", async () => {
		assert.match(ref.name, /^computer-[0-9a-f]{12}$/);
		assert.match(ref.id, /^[0-9a-f]{64}$/);
		assert.deepEqual(await provider.attach({ id: ref.name }), { ok: true, value: ref });
		assert.deepEqual(await provider.attach({ id: ref.id }), { ok: true, value: ref });
		assert.deepEqual(await provider.attach({ id: ref.id.slice(0, 12) }), { ok: true, value: ref });
	});

	it("a computer's name no container has is not_found", async () => {
		const gone = await provider.attach({ id: "computer-000000000000" });
		assert.equal(gone.ok, false);
		assert.equal(gone.error.code, "not_found");
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
