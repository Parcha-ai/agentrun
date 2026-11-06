// Files in a Docker computer as only Docker shows them (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): /work is the default
// user's own, mode 700, and a tree archived by this machine's tar is pushed under it, owned by that user, and the pull
// is extracted by the host's tar the same. What every provider must do with files is in the conformance suite
// (conformance.docker.test.mjs), with archives the suite writes itself. Needs `npm run build` and
// `npm run build:daemon` first, debian:bookworm-slim pulled, and tar on this machine. Every container this file makes
// is removed by its exact name in the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider, pullTar, pushTar } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");
/** The provider's default user, which the daemon and so every file it writes has: this process's, or 1000:1000 as root. */
const [UID, GID] = (process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000").split(":").map(Number);

/** Every entry below root: its type, mode, and content hash or link target. */
function tree(root, dir = "") {
	const rows = [];
	for (const name of readdirSync(join(root, dir)).sort()) {
		const rel = dir === "" ? name : `${dir}/${name}`;
		const stat = lstatSync(join(root, rel));
		const mode = (stat.mode & 0o7777).toString(8);
		if (stat.isSymbolicLink()) rows.push(`${rel} symlink -> ${readlinkSync(join(root, rel))}`);
		else if (stat.isDirectory()) rows.push(`${rel} dir ${mode}`, ...tree(root, rel));
		else rows.push(`${rel} file ${mode} ${createHash("sha256").update(readFileSync(join(root, rel))).digest("hex")}`);
	}
	return rows;
}

describe("the host's tar and a Docker computer", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	const local = [];
	let connection;

	const scratch = () => {
		const dir = mkdtempSync(join(tmpdir(), "computer-files-"));
		local.push(dir);
		return dir;
	};

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		const provider = new DockerProvider({ daemonPath });
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", labels: { "agentrun.test": "files" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
	});

	after(async () => {
		await connection?.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already removed.
			}
		}
		for (const dir of local) rmSync(dir, { recursive: true, force: true });
	});

	it("has /work, the default user's own with mode 700", async () => {
		const home = await connection.client.call("files.stat", { path: "/work" });
		assert.equal(home.ok, true, JSON.stringify(home));
		assert.deepEqual([home.value.type, home.value.mode, home.value.uid, home.value.gid], ["dir", 0o700, UID, GID]);
	});

	it("pushes a tree the host's tar archived, and the host's tar extracts the pull the same", async () => {
		const src = scratch();
		mkdirSync(join(src, "nested", "deeper"), { recursive: true });
		writeFileSync(join(src, "nested", "deeper", "leaf.txt"), "leaf\n");
		writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho ran from a pushed tar\n");
		chmodSync(join(src, "run.sh"), 0o755);
		writeFileSync(join(src, "nested", "data.bin"), randomBytes(1536 * 1024));
		chmodSync(join(src, "nested", "data.bin"), 0o600);
		symlinkSync("nested/deeper/leaf.txt", join(src, "leaf-link"));
		const archive = execFileSync("tar", ["-C", src, "-cf", "-", "."], { maxBuffer: 64 * 1024 * 1024 });
		const pushed = await pushTar(connection.client, "/work/data/pushed", archive);
		assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
		const ran = await connection.client.call("exec.run", { argv: ["/work/data/pushed/run.sh"], timeoutMs: 20_000 });
		assert.equal(ran.ok && decode(ran.value.stdout), "ran from a pushed tar\n");
		const owners = await connection.client.call("exec.run", {
			argv: ["stat", "-c", "%a %u:%g", "/work/data/pushed/run.sh", "/work/data/pushed/nested/data.bin"],
			timeoutMs: 20_000,
		});
		assert.equal(owners.ok && decode(owners.value.stdout), `755 ${UID}:${GID}\n600 ${UID}:${GID}\n`);
		const pulled = await pullTar(connection.client, "/work/data/pushed");
		assert.equal(pulled.ok, true, JSON.stringify(pulled.error));
		const back = scratch();
		execFileSync("tar", ["-C", back, "-xpf", "-"], { input: pulled.value });
		assert.deepEqual(tree(back), tree(src));
	});
});
