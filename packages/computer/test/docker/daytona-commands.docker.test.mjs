// The commands the Daytona provider sends into a sandbox, run where Daytona would run them: a root container (Daytona's
// container class runs code as root), the install piped to a shell's stdin as /process/execute does, init detached, the
// bridge on stdin and stdout. On a Debian image (util-linux, coreutils) and an Alpine one (BusyBox only, as in Daytona's
// default snapshot), so the provider relies on no privilege tool of the image's. AGENTRUN_COMPUTER_LIVE_DOCKER=1 only;
// needs `npm run build` and `npm run build:daemon`, and debian:bookworm-slim and alpine:3.20 pulled. Each container is
// named computer-daytona-<hex> and removed by that name, pass or fail.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

/**
 * Each image, and how a setuid-root `id` is made in it before the daemon starts: coreutils' id copied, or BusyBox's
 * binary copied under the name id, so BusyBox runs its id applet.
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

	/** A root container of image with the daemon at the staging path, as the toolbox's upload leaves it. */
	function sandbox(image) {
		const name = `computer-daytona-${randomBytes(6).toString("hex")}`;
		names.push(name);
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemon = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		docker("run", "--detach", "--name", name, image, "sleep", "600");
		docker("cp", daemon, `${name}:${STAGING}`);
		return { name, arch, sha: createHash("sha256").update(readFileSync(daemon)).digest("hex") };
	}

	for (const { image, suid, copy } of IMAGES) {
		it(`${image}: installs the daemon, init drops itself to 1000:1000 with no capabilities on every thread, and the bridge speaks the protocol`, async () => {
			const { name, arch, sha } = sandbox(image);
			const commands = daytonaCommands({ staging: STAGING, deadline: new Date(Date.now() + 300_000).toISOString() });
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
				for (const set of CAPS) assert.equal(each[set], "0000000000000000", `thread ${tid} ${set}`);
			}

			assert.equal(await run([suid, "-u"]), "1000\n", `${suid} is setuid root; with no_new_privs it runs as the daemon's user`);
			client.close();
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
