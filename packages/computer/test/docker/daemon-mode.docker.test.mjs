// A daemon installed under umask 077, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): npm installs the package's
// daemons at 0755 minus the installer's umask, so they arrive 0700. The provider binds its own 0755 copy, kept in a
// directory only this user may enter (Docker reads the bind's source as root), and the computer runs init as a user
// that is neither root nor the file's owner, which answers hello. Needs `npm run build` and `npm run build:daemon`
// first, and the image pulled. The computer is removed by its exact name, and the temp dir, in the after hook.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");
/** A non-root uid that does not own the daemon's copy, which this process owns. */
const USER = process.getuid() === 1000 ? "2000" : "1000";

describe("a Docker computer whose daemon was installed under umask 077", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	let dir;
	let installed;
	let cache;
	let provider;
	let ref;
	let connection;

	before(() => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const built = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(built), `no daemon for Docker's arch at ${built}: run npm run build:daemon`);
		dir = realpathSync(mkdtempSync(join(tmpdir(), "computer-daemon-mode-")));
		installed = join(dir, "computerd");
		// What `umask 077; npm i` leaves: the package's 0755 file, less the umask's bits.
		copyFileSync(built, installed);
		chmodSync(installed, 0o755 & ~0o077);
		assert.equal(statSync(installed).mode & 0o7777, 0o700);
		cache = join(dir, "cache");
		provider = new DockerProvider({ daemonPath: installed, daemonCache: cache });
	});

	after(async () => {
		await connection?.close();
		if (ref !== undefined) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", ref.name], { stdio: "ignore" });
			} catch {
				// Already removed.
			}
		}
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it(`creates a computer running as user ${USER}, neither root nor the daemon file's owner`, async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 10 * 60_000, network: "none", user: USER, labels: { "agentrun.test": "daemon-mode" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		ref = created.value;
	});

	it("binds a 0755 copy named by the daemon's sha256, in a 0700 directory of this user's, never the 0700 original", () => {
		const [inspected] = JSON.parse(docker("inspect", ref.name));
		const mount = inspected.Mounts.find((m) => m.Destination === "/opt/agentrun/computerd");
		assert.ok(mount, "the daemon is mounted");
		assert.equal(mount.RW, false);
		assert.notEqual(mount.Source, installed);
		assert.equal(dirname(mount.Source), cache);
		assert.equal(basename(mount.Source), `computerd-${createHash("sha256").update(readFileSync(installed)).digest("hex")}`);
		const file = lstatSync(mount.Source);
		assert.ok(file.isFile());
		assert.equal(file.mode & 0o7777, 0o755);
		assert.equal(file.uid, process.getuid());
		const parent = lstatSync(cache);
		assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
		assert.equal(parent.mode & 0o7777, 0o700);
		assert.equal(parent.uid, process.getuid());
		assert.equal(statSync(installed).mode & 0o7777, 0o700, "the installed file is never changed");
		assert.equal(inspected.Config.User, `${USER}:${USER}`);
		assert.equal(inspected.State.Running, true);
	});

	it("runs init as PID 1, which answers hello, and runs a command as that user", async () => {
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
		assert.equal(connection.hello.os, "linux");
		const script = "id -u; stat -c '%u %a' /opt/agentrun/computerd; test -x /opt/agentrun/computerd && echo runnable || echo not-runnable; tr '\\0' ' ' < /proc/1/cmdline";
		const ran = await connection.client.call("exec.run", { argv: ["sh", "-c", script], timeoutMs: 20_000 });
		assert.equal(ran.ok, true, JSON.stringify(ran));
		const [uid, daemon, runnable, init] = decode(ran.value.stdout).trim().split("\n");
		assert.equal(uid, USER);
		const [owner, mode] = daemon.split(" ");
		assert.equal(mode, "755", "the computer sees the copy's own mode");
		assert.equal(runnable, "runnable", `the computer's user ${USER} may run the copy`);
		// A host that remaps ids (userns-remap, rootless Docker) shows the computer another uid for the copy's owner, so
		// the owner is compared only where ids are not remapped: hostOf reads that from docker info's SecurityOptions.
		const host = await provider.host();
		assert.equal(host.ok, true, JSON.stringify(host));
		if (host.value.remap === undefined) assert.equal(Number(owner), process.getuid(), "the computer sees the copy's own owner");
		assert.match(init, /^\/opt\/agentrun\/computerd init --deadline /);
	});
});
