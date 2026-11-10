// The provider's volume option on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): a named volume stands for the one a
// server in a container keeps its files on, its files in a directory of this machine (a local volume bound there), which
// is the provider's volume root. The daemon's copy and the run's folder are mounted into the computer as that volume's
// subpaths: the daemon runs from it, a file the computer writes in /workspace is in the run's folder, and the inspect
// holds volume mounts with their subpaths, no bind. Needs `npm run build` and `npm run build:daemon` first, Docker Engine
// 26 or later (skipped in words on an older one), and the image pulled. The computer and the volume are removed in the
// after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider, VOLUME_SUBPATH_ENGINE } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");
const engine = () => Number(/^(\d+)\./.exec(docker("version", "--format", "{{.Server.Version}}").trim())?.[1] ?? 0);
const skip = !LIVE ? "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" : engine() < VOLUME_SUBPATH_ENGINE ? `Docker Engine <${VOLUME_SUBPATH_ENGINE} cannot mount a volume's subpath` : false;

describe("a Docker computer whose daemon and run folder are a named volume's subpaths", { skip }, () => {
	const name = `agentrun-test-volume-${randomBytes(6).toString("hex")}`;
	let root;
	let work;
	let provider;
	let ref;

	before(() => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		root = realpathSync(mkdtempSync(join(tmpdir(), "computer-volume-root-")));
		work = join(root, "disk", "runs", "r1", "work");
		mkdirSync(work, { recursive: true });
		if (process.getuid() === 0) chownSync(work, 1000, 1000);
		chmodSync(work, 0o700);
		// A local volume whose files are this directory: what the server's container sees at its root, Docker has here.
		docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", `device=${root}`, "--opt", "o=bind", name);
		provider = new DockerProvider({ daemonPath, daemonCache: join(root, "cache"), volume: { name, root } });
	});

	after(() => {
		if (ref) execFileSync("docker", ["rm", "--force", ref.name], { stdio: "ignore" });
		execFileSync("docker", ["volume", "rm", "--force", name], { stdio: "ignore" });
		rmSync(root, { recursive: true, force: true });
	});

	it("creates the computer, the daemon running from the volume's subpath and the run's folder another of its subpaths, with no bind", async () => {
		const made = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", mount: { kind: "bind", path: work }, labels: { "agentrun.test": "volume" } });
		assert.equal(made.ok, true, JSON.stringify(made));
		ref = made.value;
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		const asked = inspected.HostConfig.Mounts.map((mount) => [mount.Type, mount.Source, mount.Target, mount.VolumeOptions?.Subpath, mount.ReadOnly === true]);
		assert.deepEqual(asked, [
			["volume", name, "/opt/agentrun/computerd", asked[0][3], true],
			["volume", name, "/workspace", "disk/runs/r1/work", false],
		]);
		assert.match(asked[0][3], /^cache\/computerd-[0-9a-f]{64}$/);
		assert.ok(!inspected.Mounts.some((mount) => mount.Type === "bind"), JSON.stringify(inspected.Mounts));
	});

	it("runs commands through the daemon, and a file written in /workspace is in the run's folder", async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		try {
			const ran = await connected.value.client.call("exec.run", { argv: ["sh", "-c", "echo from the computer > /workspace/written && ls /workspace"], timeoutMs: 20_000 });
			assert.equal(ran.ok, true, JSON.stringify(ran));
			assert.equal(ran.value.exitCode, 0, decode(ran.value.stderr));
			assert.equal(decode(ran.value.stdout).trim(), "written");
		} finally {
			await connected.value.close();
		}
		assert.equal(readFileSync(join(work, "written"), "utf8"), "from the computer\n");
	});

	it("attach and list read the run's folder back as the path create was given", async () => {
		const attached = await provider.attach({ id: ref.name });
		assert.equal(attached.ok, true, JSON.stringify(attached));
		assert.deepEqual(attached.value.spec.mount, { kind: "bind", path: work });
		const listed = await provider.list({ "agentrun.test": "volume" });
		assert.deepEqual(listed.ok && listed.value.map((info) => info.mount), [{ kind: "bind", path: work }]);
	});

	it("release(delete) removes the computer and leaves the volume's files", async () => {
		assert.deepEqual(await provider.release(ref, "delete"), { ok: true, value: undefined });
		ref = undefined;
		assert.equal(readFileSync(join(work, "written"), "utf8"), "from the computer\n");
	});
});
