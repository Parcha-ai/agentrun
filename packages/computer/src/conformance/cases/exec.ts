// exec.run: argv not a shell, split streams, the exit code, a timeout and an abort that end the whole tree, truncation,
// cwd and a minimal environment, and a user that is honoured or refused, never ignored.
import type { Case } from "../types.js";
import { alive } from "./util.js";

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
		t.deepEqual(Object.keys(vars).sort(), ["GREETING", "HOME", "LOGNAME", "PATH", "USER"], "the environment: the minimal default and env, nothing else");
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
		const script = `p=$(mktemp -u); mkfifo "$p"; setsid sh -c 'echo $$ > "$0"; exec sleep 302' "$p" >/dev/null 2>&1 </dev/null & read pid < "$p"; echo $pid`;
		const ran = await t.exec(["sh", "-c", script]);
		t.equal(ran.exitCode, 0, `the script's exit code (stderr ${JSON.stringify(ran.err)})`);
		const pid = Number(ran.out.trim());
		t.assert(pid > 1, `the escapee's pid, from ${JSON.stringify(ran.out)}`);
		t.equal((await t.exec(["sh", "-c", alive([pid])])).out, "", "a child that left the program's session, after the program ended: gone");
	}),
	exec("user", async (t) => {
		const own = (await t.exec(["id", "-u"])).out.trim();
		const other = await t.client.call("exec.run", { argv: ["id", "-u"], user: "nobody", timeoutMs: t.patience });
		if (other.ok) {
			const uid = Buffer.from(other.value.stdout, "base64").toString("utf8").trim();
			t.assert(uid !== own, `a run as nobody runs as nobody, not as the daemon's user (uid ${own})`);
			t.equal((await t.exec(["id", "-un"], { user: "nobody" })).out, "nobody\n", "the user name of a run as nobody");
		} else {
			const error = t.refused(other, "a user the daemon cannot switch to", ["denied"]);
			t.assert(error.message !== "", "the refusal is in words");
		}
	}),
];
