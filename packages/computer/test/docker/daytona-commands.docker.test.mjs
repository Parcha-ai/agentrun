// The commands the Daytona provider sends into a sandbox, run where Daytona would run them: a root container (Daytona's
// container class runs code as root), the install piped to a shell's stdin as /process/execute does, init detached, the
// bridge on stdin and stdout. On a Debian image (util-linux, coreutils) and an Alpine one (BusyBox only, as in Daytona's
// default snapshot), so the provider relies on no privilege tool of the image's. AGENTRUN_COMPUTER_LIVE_DOCKER=1 only;
// needs `npm run build` and `npm run build:daemon`, and debian:bookworm-slim and alpine:3.20 pulled. Each container is
// named computer-daytona-<hex> and removed by that name, pass or fail.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { DaemonClient } from "../../dist/index.js";
import { daytonaCommands } from "../../dist/daytona.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const STAGING = "/tmp/agentrun-computerd-0123456789abcdef";
const CAPS = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];

/** A command in a container, as root unless a user is given: piped to a shell's stdin as /process/execute does, or as
 *  `sh -c` as a session command runs, with empty stdin. Never throws: the exit status and both streams. */
function shell(name, command, { user, piped = false } = {}) {
	const as = user ? ["--user", user] : [];
	const argv = piped ? ["exec", "-i", ...as, name, "sh"] : ["exec", "-i", ...as, name, "sh", "-c", command];
	const ran = spawnSync("docker", argv, { input: piped ? command : "", encoding: "utf8", timeout: 60_000 });
	return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

/**
 * Each image, and how a setuid-root `id` is made in it before the daemon starts: coreutils' id copied, or BusyBox's
 * binary copied under the name id, so BusyBox runs its id applet. Run by uid 1000 without no_new_privs, coreutils' copy
 * prints 0; BusyBox's id applet drops a setuid root itself, so on Alpine the check holds either way.
 */
const IMAGES = [
	{ image: "debian:bookworm-slim", suid: "/tmp/suid-id", copy: "cp /usr/bin/id /tmp/suid-id" },
	{ image: "alpine:3.20", suid: "/tmp/id", copy: "cp /bin/busybox /tmp/id" },
];

/** A /proc status file's fields, by name. */
const fieldsOf = (text) =>
	Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line.includes(":"))
			.map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
	);

describe("the Daytona provider's commands in a root container", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const names = [];
	const children = [];
	after(() => {
		for (const child of children) child.kill("SIGKILL");
		for (const name of names) execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	});

	/**
	 * A root container of image with the daemon at the staging path, as the toolbox's upload leaves it, given the two
	 * capabilities init --own-network needs, as Daytona's root (the open runner runs it privileged) holds.
	 */
	function sandbox(image) {
		const name = `computer-daytona-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemon = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		docker("run", "--detach", "--name", name, "--cap-add", "SYS_ADMIN", "--cap-add", "NET_ADMIN", image, "sleep", "600");
		docker("cp", daemon, `${name}:${STAGING}`);
		return { name, arch, sha: createHash("sha256").update(readFileSync(daemon)).digest("hex") };
	}

	for (const { image, suid, copy } of IMAGES) {
		it(`${image}: installs the daemon, init drops itself to 1000:1000 with no capabilities and the filter on every thread, and the bridge speaks the protocol`, async () => {
			const { name, arch, sha } = sandbox(image);
			const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString(), user: "1000:1000" });
			const installed = execFileSync("docker", ["exec", "-i", name, "sh"], { input: commands.install, encoding: "utf8" });
			assert.equal(installed.trim(), `sha256 ${sha}`, "the install prints the installed binary's sha256");
			assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", "/opt/agentrun/computerd").trim(), "0:0 755");
			assert.equal(docker("exec", name, "sh", "-c", `test -e ${STAGING} && echo left || echo gone`).trim(), "gone");

			// A setuid-root id, made as root before the daemon starts: run by the daemon's user it must not regain root.
			docker("exec", name, "sh", "-c", `${copy} && chmod 4755 ${suid}`);
			assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", suid).trim(), "0:0 4755");

			docker("exec", "--detach", name, "sh", "-c", commands.init);
			const child = spawn("docker", ["exec", "-i", name, "sh", "-c", commands.stdio], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			const client = new DaemonClient({ readable: child.stdout, writable: child.stdin });
			const hello = await client.call("hello", { client: "daytona-commands test" }, { signal: AbortSignal.timeout(30_000) });
			assert.equal(hello.ok, true, JSON.stringify(hello));
			assert.equal(hello.value.arch, arch);

			const status = await client.call("files.read", { path: "/proc/self/status" });
			const fields = fieldsOf(Buffer.from(status.value.data, "base64").toString());
			assert.equal(fields.Uid, "1000\t1000\t1000\t1000");
			assert.equal(fields.Gid, "1000\t1000\t1000\t1000");
			assert.equal(fields.Groups, "", "getgroups is empty");
			assert.equal(fields.NoNewPrivs, "1");
			for (const set of CAPS) assert.equal(fields[set], "0000000000000000", set);
			assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", "/work", "/run/agentrun").trim(), "1000:1000 700\n1000:1000 700");
			assert.equal((await client.call("files.stat", { path: "/proc/self/cwd" })).value.target, "/work");
			assert.equal((await client.call("files.stat", { path: "/proc/self/exe" })).value.target, "/opt/agentrun/computerd");

			const run = async (argv) => {
				const ran = await client.call("exec.run", { argv, timeoutMs: 10_000 });
				assert.equal(ran.ok, true, JSON.stringify(ran));
				return Buffer.from(ran.value.stdout, "base64").toString();
			};
			assert.equal(await run(["sh", "-c", 'id -u; id -G; echo ok > "$HOME/x" && cat "$HOME/x"; echo x > /opt/agentrun/computerd || echo denied']), "1000\n1000\nok\ndenied\n");

			// Every thread of the daemon, not only the one that answered files.read.
			const tasks = (await run(["sh", "-c", 'for t in /proc/"$1"/task/*; do echo "task ${t##*/}"; cat "$t/status"; done', "sh", fields.Pid]))
				.split(/^task /m)
				.filter(Boolean);
			assert.ok(tasks.length >= 2, `the daemon has ${tasks.length} threads; a Go program has more than one`);
			for (const task of tasks) {
				const tid = task.slice(0, task.indexOf("\n"));
				const each = fieldsOf(task);
				assert.equal(each.Uid, "1000\t1000\t1000\t1000", `thread ${tid} Uid`);
				assert.equal(each.Gid, "1000\t1000\t1000\t1000", `thread ${tid} Gid`);
				assert.equal(each.Groups, "", `thread ${tid} Groups`);
				assert.equal(each.NoNewPrivs, "1", `thread ${tid} NoNewPrivs`);
				assert.equal(each.Seccomp, "2", `thread ${tid} Seccomp: the filter that refuses vsock and io_uring`);
				for (const set of CAPS) assert.equal(each[set], "0000000000000000", `thread ${tid} ${set}`);
			}

			assert.equal(await run([suid, "-u"]), "1000\n", `${suid} is setuid root; with no_new_privs it runs as the daemon's user`);
			client.close();
		});

		it(`${image}: the install takes back a daemon directory another user owns, and refuses one under a directory another user can write`, () => {
			const { name, sha } = sandbox(image);
			const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString() });
			// A snapshot may already hold the directory, owned by the computer's user.
			docker("exec", name, "sh", "-c", "mkdir -p /opt/agentrun && chown 1000:1000 /opt/agentrun && chmod 0755 /opt/agentrun");
			const installed = shell(name, commands.install, { piped: true });
			assert.equal(installed.status, 0, installed.stdout + installed.stderr);
			assert.equal(installed.stdout.trim(), `sha256 ${sha}`);
			assert.equal(docker("exec", name, "stat", "-c", "%u:%g %a", "/opt/agentrun", "/opt/agentrun/computerd").trim(), "0:0 755\n0:0 755");
			const swapped = shell(name, "mv /opt/agentrun/computerd /tmp/computerd", { user: "1000:1000" });
			assert.notEqual(swapped.status, 0, "the computer's user cannot move the daemon out of its directory");
			assert.equal(docker("exec", name, "sh", "-c", "test -e /tmp/computerd && echo moved || echo kept").trim(), "kept");

			// A directory above it that another user can write: that user could rename /opt/agentrun and make its own.
			const open = sandbox(image);
			docker("exec", open.name, "chmod", "0777", "/opt");
			const refused = shell(open.name, commands.install, { piped: true });
			assert.equal(refused.status, 6, refused.stdout + refused.stderr);
			assert.match(refused.stdout, /the daemon at \/opt\/agentrun\/computerd is not root's alone: \/opt is drwxrwxrwx, owner 0/);
			assert.equal(docker("exec", open.name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent");
		});

		it(`${image}: init and the bridge never run, as root, a daemon another user could have replaced`, () => {
			const { name, sha } = sandbox(image);
			const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString() });
			assert.equal(shell(name, commands.install, { piped: true }).stdout.trim(), `sha256 ${sha}`);
			// The directory as an older install left it when the snapshot already held it, owned by the computer's user,
			// who then swaps the binary for one that records who ran it.
			docker("exec", name, "chown", "1000:1000", "/opt/agentrun");
			const swap = shell(name, "mv /opt/agentrun/computerd /opt/agentrun/real && printf '#!/bin/sh\\nid -u > /tmp/ran-as\\n' > /opt/agentrun/computerd && chmod 0755 /opt/agentrun/computerd", { user: "1000:1000" });
			assert.equal(swap.status, 0, swap.stderr);
			for (const which of ["init", "stdio"]) {
				const ran = shell(name, commands[which]);
				assert.equal(ran.status, 6, `${which}: ${ran.stdout}${ran.stderr}`);
				assert.match(ran.stderr, /the daemon at \/opt\/agentrun\/computerd is not root's alone: \/opt\/agentrun\/computerd is -rwxr-xr-x, owner 1000/, which);
				assert.equal(docker("exec", name, "sh", "-c", "cat /tmp/ran-as 2>/dev/null || echo never ran").trim(), "never ran", which);
			}
			// A root-owned binary in that directory is refused too: its owner could swap it at any time.
			docker("exec", name, "sh", "-c", "mv /opt/agentrun/real /opt/agentrun/computerd && chown 0:0 /opt/agentrun/computerd");
			for (const which of ["init", "stdio"]) {
				const ran = shell(name, commands[which]);
				assert.equal(ran.status, 6, `${which}: ${ran.stdout}${ran.stderr}`);
				assert.match(ran.stderr, /the daemon at \/opt\/agentrun\/computerd is not root's alone: \/opt\/agentrun is drwxr-xr-x, owner 1000/, which);
			}
		});

		it(`${image}: an install by a user that is not root and has no sudo says why, and installs nothing`, () => {
			const { name } = sandbox(image);
			const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString() });
			let failed;
			try {
				execFileSync("docker", ["exec", "-i", "--user", "1000:1000", name, "sh"], { input: commands.install, encoding: "utf8" });
			} catch (error) {
				failed = error;
			}
			assert.equal(failed?.status, 3);
			assert.match(failed.stdout, /is not root and has no passwordless sudo, so the daemon cannot be installed/);
			assert.equal(docker("exec", name, "sh", "-c", "test -e /opt/agentrun/computerd && echo there || echo absent").trim(), "absent");
		});
	}
});
