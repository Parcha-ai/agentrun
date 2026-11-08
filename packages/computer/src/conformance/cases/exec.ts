// exec.run: argv not a shell, split streams, the exit code, a timeout and an abort that end the whole tree, truncation,
// cwd and a minimal environment, a user that is not root with no capabilities in any set and no_new_privs, a user switch
// honoured or refused, never ignored; Full: root or another uid when the spec asks, still with no capabilities.
import type { Case, CaseContext } from "../types.js";
import { alive } from "./util.js";

const NONE = "0000000000000000";
/**
 * A program the daemon runs holds no capability in any set, the bounding and ambient sets included, so neither it nor
 * a program it starts can gain one, root included; and no_new_privs is set. A field the kernel does not report fails.
 */
function noCapabilities(t: CaseContext, status: string) {
	const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, "m").exec(status)?.[1];
	for (const set of ["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"]) t.equal(field(set), NONE, `${set} in /proc/self/status: no capabilities`);
	t.equal(field("NoNewPrivs"), "1", "NoNewPrivs in /proc/self/status: set");
}

const exec = (name: string, run: Case["run"]): Case => ({ id: `exec.${name}`, level: "core", group: "exec", needs: ["exec"], run });

export const execCases: Case[] = [
	exec("argv", async (t) => {
		const ran = await t.exec(["echo", "$(id)", "`id`", "a;b", "*", "two words"]);
		t.equal(ran.out, "$(id) `id` a;b * two words\n", "argv is never expanded in a shell");
	}),
	exec("streams", async (t) => {
		const ran = await t.exec(["sh", "-c", "echo to-out; echo to-err >&2; echo more-out"]);
		t.equal(ran.out, "to-out\nmore-out\n", "stdout");
		t.equal(ran.err, "to-err\n", "stderr");
	}),
	exec("exit-code", async (t) => {
		const ran = await t.exec(["sh", "-c", "exit 7"]);
		t.equal(ran.exitCode, 7, "the exit code");
		t.equal(ran.timedOut, false, "timedOut");
		t.equal(ran.truncated, false, "truncated");
		t.equal(ran.signal, undefined, "the signal");
		t.equal((await t.exec(["true"])).exitCode, 0, "true's exit code");
	}),
	exec("cwd", async (t) => {
		t.equal((await t.exec(["pwd"], { cwd: "/tmp" })).out, "/tmp\n", "pwd in cwd /tmp");
	}),
	exec("env", async (t) => {
		const ran = await t.exec(["env"], { env: { GREETING: "hello there" } });
		const vars = Object.fromEntries(
			ran.out
				.split("\n")
				.filter(Boolean)
				.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
		);
		t.equal(vars.GREETING, "hello there", "a variable the call adds");
		// USER and LOGNAME name the account, so a uid with no name has neither.
		const named = "USER" in vars ? ["LOGNAME", "USER"] : [];
		t.deepEqual(Object.keys(vars).sort(), ["GREETING", "HOME", "PATH", ...named].sort(), "the environment: PATH, HOME, USER and LOGNAME when the user has a name, and env; nothing else");
		t.equal(vars.LOGNAME, vars.USER, "LOGNAME and USER");
	}),
	exec("timeout", async (t) => {
		const ran = await t.exec(["sh", "-c", "sleep 300 & echo $!; wait"], { timeoutMs: 1000 });
		t.equal(ran.timedOut, true, "timedOut");
		t.equal(ran.exitCode, null, "the exit code of a program ended by a signal");
		t.equal(ran.signal, "TERM", "the signal that ended it");
		const pid = Number(ran.out.trim());
		t.assert(pid > 1, `the background sleep's pid, from ${JSON.stringify(ran.out)}`);
		t.equal((await t.exec(["sh", "-c", alive([pid])])).out, "", "the background sleep after the timeout: gone");
	}),
	exec("abort", async (t) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 500);
		const ran = await t.client.call("exec.run", { argv: ["sleep", "301"], timeoutMs: 60_000 }, { signal: controller.signal });
		t.refused(ran, "an aborted exec.run", ["aborted"]);
		await t.until(async () => !(await t.exec(["sh", "-c", "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '"])).out.includes("sleep 301"), "sleep 301 ended after the abort");
	}),
	exec("truncation", async (t) => {
		const ran = await t.exec(["head", "-c", "100000", "/dev/zero"], { maxOutput: 1000 });
		t.equal(ran.truncated, true, "truncated");
		t.equal(Buffer.byteLength(ran.out), 1000, "the bytes kept of stdout");
		t.equal(ran.exitCode, 0, "the program's exit code: the rest was read and dropped, not cut off");
	}),
	exec("setsid-escapee", async (t) => {
		const script = `p="$HOME/agentrun-conformance-fifo-$$"; mkfifo "$p"; setsid sh -c 'echo $$ > "$0"; exec sleep 302' "$p" >/dev/null 2>&1 </dev/null & read pid < "$p"; rm -f "$p"; echo $pid`;
		const ran = await t.exec(["sh", "-c", script]);
		t.equal(ran.exitCode, 0, `the script's exit code (stderr ${JSON.stringify(ran.err)})`);
		const pid = Number(ran.out.trim());
		t.assert(pid > 1, `the escapee's pid, from ${JSON.stringify(ran.out)}`);
		t.equal((await t.exec(["sh", "-c", alive([pid])])).out, "", "a child that left the program's session, after the program ended: gone");
	}),
	// The run's spec asks for no user, so a computer's programs run as the provider's non-root default.
	exec("unprivileged", async (t) => {
		const uid = (await t.exec(["id", "-u"])).out.trim();
		t.assert(uid !== "" && uid !== "0", `id -u: the computer's user is ${uid === "0" ? "root" : JSON.stringify(uid)}, though the spec did not ask for root`);
		noCapabilities(t, (await t.exec(["cat", "/proc/self/status"])).out);
	}),
	exec("user", async (t) => {
		const own = (await t.exec(["id", "-u"])).out.trim();
		// A uid other than the computer's own, so a run that ignored user cannot pass for one that honoured it.
		const target = own === "65534" ? "65533" : "65534";
		const other = await t.client.call("exec.run", { argv: ["id", "-u"], user: target, timeoutMs: t.patience });
		if (other.ok) {
			const uid = Buffer.from(other.value.stdout, "base64").toString("utf8").trim();
			t.equal(uid, target, `id -u in a run as uid ${target}, from a computer whose user is uid ${own}`);
		} else {
			const error = t.refused(other, `a run as uid ${target}, which the daemon cannot switch to`, ["denied"]);
			t.assert(error.message !== "", "the refusal is in words");
		}
	}),
	{
		id: "exec.root-on-request",
		level: "full",
		group: "exec",
		needs: ["exec", "user:root"],
		computer: "none",
		async run(t) {
			const connected = await t.connect(await t.create({ user: "0" }));
			const ran = (argv: string[]) => t.exec(argv, {}, connected.client);
			t.equal((await ran(["id", "-u"])).out.trim(), "0", "id -u in a computer whose spec asked for user 0");
			noCapabilities(t, (await ran(["cat", "/proc/self/status"])).out);
		},
	},
	{
		id: "exec.user-uid",
		level: "full",
		group: "exec",
		needs: ["exec", "user:uid"],
		computer: "none",
		async run(t) {
			const connected = await t.connect(await t.create({ user: "65534" }));
			const ran = (argv: string[]) => t.exec(argv, {}, connected.client);
			t.equal((await ran(["id", "-u"])).out.trim(), "65534", "id -u in a computer whose spec asked for user 65534");
			noCapabilities(t, (await ran(["cat", "/proc/self/status"])).out);
			const home = await ran(["sh", "-c", 'echo ok > "$HOME/x" && cat "$HOME/x"']);
			t.equal(home.out, "ok\n", `a write in HOME, as user 65534 (stderr ${JSON.stringify(home.err)})`);
		},
	},
];
