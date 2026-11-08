// bash and the five background tools on a real Docker computer (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): every call goes
// through computerd's process.* methods, and what the command does in the computer is the real thing: a shell, its
// jobs, its terminal, its signals. The words are the unit test's (bash-tools.test.mjs). Needs `npm run build` and
// `npm run build:daemon` first, and debian:bookworm-slim pulled. The run's folder (/workspace) is mounted by a later
// change, so every call here names /tmp as its folder. Each container this file makes is removed by its exact name in
// the after hook, pass or fail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { bash, bashBackground, bashInput, bashList, bashOutput, bashSignal, DockerProvider, endBackground } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const IMAGE = "debian:bookworm-slim";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const AT = { cwd: "/tmp" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every sleep running in the computer, by its /proc entry, or "none" (the image has no pgrep). */
const SLEEPS = "grep -lx sleep /proc/[0-9]*/comm 2>/dev/null || echo none";

const answer = (result) => {
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.value;
};
const refused = (result, code, words) => {
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result));
	assert.match(result.error.message, words);
};

describe("bash and the background tools on a Docker computer", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const made = [];
	const open = [];
	let provider;
	let client;

	/** A fresh computer and a client on it: each test's background processes start from none. */
	const fresh = async () => {
		const created = await provider.create({ image: IMAGE, lifetimeMs: 15 * 60_000, network: "none", labels: { "agentrun.test": "bash-tools" } });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.push(created.value.name);
		const connected = await provider.connect(created.value);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		open.push(connected.value);
		return connected.value.client;
	};
	/** Starts command in the background; answers its id. */
	const background = async (command, tty = false) => answer(await bashBackground(client, { command, ...(tty ? { tty } : {}) }, AT)).details.id;
	/** Whether pid still runs in the computer (not a zombie). */
	const alive = async (pid) => {
		const ran = answer(await bash(client, { command: `s=$(sed 's/^.*) //' /proc/${pid}/stat 2>/dev/null | cut -d' ' -f1); [ -n "$s" ] && [ "$s" != Z ] && echo alive || echo gone`, ...AT }));
		return ran.output.trim() === "alive";
	};
	/** Reads id's output until it holds want, bounded. */
	const until = async (id, want, ms = 20_000) => {
		const by = Date.now() + ms;
		let text = "";
		while (Date.now() < by) {
			text = answer(await bashOutput(client, { id })).text;
			if (want.test(text)) return text;
			await sleep(200);
		}
		assert.fail(`background process ${id} never showed ${want}: ${JSON.stringify(text)}`);
	};

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		provider = new DockerProvider({ daemonPath });
	});

	after(async () => {
		for (const connection of open) await connection.close();
		for (const name of made) {
			try {
				execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
			} catch {
				// Already gone.
			}
		}
	});

	it("demo: starts `echo started; sleep 30; echo done`, lists it, signals it and sees it gone, at once", async () => {
		client = await fresh();
		const begun = Date.now();
		const id = await background("echo started; sleep 30; echo done");
		await until(id, /started\n$/);
		assert.match(answer(await bashList(client)).text, new RegExp(`^1 of at most 8 running\\.\\n${id}: is running; 8 bytes of output; started \\d{4}-\\d\\d-\\d\\dT[\\d:]+Z; "echo started; sleep 30; echo done"$`));
		assert.equal(answer(await bashSignal(client, { id, signal: "TERM" })).text, `Sent TERM to background process ${id}: it ended by signal TERM (exit code 143).`);
		assert.match(answer(await bashList(client)).text, new RegExp(`^0 of at most 8 running\\.\\n${id}: ended by signal TERM \\(exit code 143\\); 8 bytes of output;`));
		assert.equal(answer(await bashOutput(client, { id })).text, `Background process ${id} ended by signal TERM (exit code 143). Output bytes 0 to 8 of 8, the end.\n\nstarted\n`);
		assert.ok(Date.now() - begun < 25_000, "nothing waited out the sleep");
	});

	it("pages by byte offset, never splitting a character, then the exit code; stderr is in the same log", async () => {
		const id = await background("printf 'one\\n'; sleep 0.2; printf 'two\\n' >&2; printf '\\342\\202\\254!'; exit 3");
		await until(id, /exited with code 3/);
		assert.equal(answer(await bashOutput(client, { id, max_bytes: 4 })).text, `Background process ${id} exited with code 3. Output bytes 0 to 4 of 12; call again with offset 4 for the next part.\n\none\n`);
		assert.equal(answer(await bashOutput(client, { id, offset: 4, max_bytes: 5 })).text, `Background process ${id} exited with code 3. Output bytes 4 to 8 of 12; call again with offset 8 for the next part.\n\ntwo\n`);
		assert.equal(answer(await bashOutput(client, { id, offset: 8 })).text, `Background process ${id} exited with code 3. Output bytes 8 to 12 of 12, the end.\n\n€!`);
		assert.equal(answer(await bashOutput(client, { id, offset: 30 })).text, `Background process ${id} exited with code 3. No output past byte 30 (the log has 12 bytes).`);
		refused(await bashSignal(client, { id, signal: "KILL" }), "invalid", /so no signal was sent/);
		refused(await bashInput(client, { id, text: "late\n" }), "invalid", /so it takes no input/);
		refused(await bashOutput(client, { id: "9999" }), "not_found", /^there is no background process 9999 in this run/);
	});

	it("a job the command leaves running keeps the process running until it ends; a signal to the group ends it", async () => {
		const id = await background("sleep 60 >/dev/null 2>&1 & echo $! > child.pid; echo parent done");
		await until(id, /parent done\n/);
		await sleep(500);
		assert.match(answer(await bashOutput(client, { id })).text, new RegExp(`^Background process ${id} is running\\. Output bytes 0 to 12 of 12, all of it so far;`));
		assert.match(answer(await bashList(client)).text, new RegExp(`\\n${id}: is running;`));
		const child = Number(answer(await bash(client, { command: "cat child.pid", ...AT })).output.trim());
		assert.equal(await alive(child), true);
		assert.match(answer(await bashSignal(client, { id, signal: "TERM" })).text, new RegExp(`^Sent TERM to background process ${id}: it ended by signal TERM \\(exit code 143\\)\\.$`));
		assert.equal(await alive(child), false, "the job is gone with it");
	});

	it("stdin reaches a `read` loop, line by line; close: true ends its input", async () => {
		const loop = await background('while read -r line; do echo "got $line"; [ "$line" = stop ] && exit 0; done; echo eof');
		answer(await bashInput(client, { id: loop, text: "hello\n" }));
		await until(loop, /got hello\n$/);
		answer(await bashInput(client, { id: loop, text: "stop\n" }));
		assert.equal(await until(loop, /exited/), `Background process ${loop} exited with code 0. Output bytes 0 to 19 of 19, the end.\n\ngot hello\ngot stop\n`);
		const cat = await background('cat; echo " (end of input)"');
		assert.equal(answer(await bashInput(client, { id: cat, text: "abc", close: true })).text, `Wrote 3 bytes to background process ${cat}'s stdin, then closed it. Read what it answers with bash_output.`);
		assert.equal(await until(cat, /exited/), `Background process ${cat} exited with code 0. Output bytes 0 to 19 of 19, the end.\n\nabc (end of input)\n`);
		const held = await background("cat > /dev/null; sleep 30");
		answer(await bashInput(client, { id: held, text: "", close: true }));
		refused(await bashInput(client, { id: held, text: "more\n" }), "invalid", /stdin is closed: an earlier bash_input closed it/);
		answer(await bashSignal(client, { id: held, signal: "KILL" }));
	});

	it("a signal ends it: INT as Ctrl-C, and KILL where TERM is ignored", async () => {
		const first = await background("sleep 30; echo done");
		await sleep(300);
		assert.equal(answer(await bashSignal(client, { id: first, signal: "INT" })).text, `Sent INT to background process ${first}: it ended by signal INT (exit code 130).`);
		const stubborn = await background("trap '' TERM; echo stubborn; sleep 30");
		await until(stubborn, /stubborn/);
		assert.equal(answer(await bashSignal(client, { id: stubborn, signal: "TERM" })).text, `Sent TERM to background process ${stubborn}: it is running. Send KILL to end it at once.`);
		assert.equal(answer(await bashSignal(client, { id: stubborn, signal: "KILL" })).text, `Sent KILL to background process ${stubborn}: it ended by signal KILL (exit code 137).`);
	});

	it("tty: a terminal for the command, a prompt answered over bash_input, Ctrl-D for close, INT to the foreground job", async () => {
		const tty = await background("tty", true);
		const plain = await background("tty");
		assert.match(await until(tty, /exited/), /^Background process \d+ exited with code 0\. .*\n\n\/dev\/pts\/\d+\r\n$/s);
		assert.match(await until(plain, /exited/), /^Background process \d+ exited with code 1\. .*\n\nnot a tty\n$/s);
		const prompt = await background("read -r -p 'name? ' n; echo \"hello $n\"", true);
		await until(prompt, /name\? $/);
		answer(await bashInput(client, { id: prompt, text: "bob\n" }));
		assert.match(await until(prompt, /exited/), /\n\nname\? bob\r\nhello bob\r\n$/);
		const cat = await background("cat; echo end of input", true);
		answer(await bashInput(client, { id: cat, text: "abc\n", close: true }));
		assert.match(await until(cat, /exited/), /exited with code 0\..*\n\nabc\r\nabc\r\n.*end of input\r\n$/s);
		const shell = await background("bash --norc --noprofile -i", true);
		await sleep(1_000);
		answer(await bashInput(client, { id: shell, text: "sleep 60\n" }));
		await sleep(1_000);
		const begun = Date.now();
		assert.match(answer(await bashSignal(client, { id: shell, signal: "INT" })).text, new RegExp(`^Sent INT to background process ${shell}: it is running\\.`));
		answer(await bashInput(client, { id: shell, text: "echo back $?\n" }));
		await until(shell, /back 130/);
		assert.ok(Date.now() - begun < 30_000, "sleep 60 did not run out");
		answer(await bashInput(client, { id: shell, text: "exit\n" }));
		assert.match(answer(await bashList(client)).text, new RegExp(`\\n${tty}: exited with code 0;[^\\n]*\\(tty\\)`));
	});

	it("a log keeps its last 8 MiB, and says what it dropped", async () => {
		const id = await background("head -c 9000000 /dev/zero | tr '\\0' x; echo; echo after the cap >&2; exit 4");
		await until(id, /exited with code 4/, 60_000);
		const read = answer(await bashOutput(client, { id }));
		assert.equal(read.details.size, 9_000_015);
		assert.equal(read.details.dropped, 9_000_015 - 8 * 1024 * 1024);
		assert.match(read.text, new RegExp(`^Background process ${id} exited with code 4\\. Output bytes 611,407 to 660,559 of 9,000,015; call again with offset 660559 for the next part\\. The log keeps the last 8 MiB of output: bytes 0 to 611,407 were dropped before they were read\\.\\n\\nx+$`));
		assert.match(answer(await bashOutput(client, { id, offset: 8_999_999 })).text, /the end\.\n\nx\nafter the cap\n$/);
	});

	it("the per-run cap refuses a ninth in words; endBackground ends every one, a TERM-proof one by KILL", async () => {
		client = await fresh();
		for (let i = 1; i <= 7; i++) await background(`echo p${i}; sleep 60`);
		const stubborn = await background("trap '' TERM; echo p8; sleep 60");
		await until(stubborn, /p8/);
		refused(await bashBackground(client, { command: "echo one too many" }, AT), "limit", /^8 background processes already run in this run's box, the most at once \(8\)/);
		assert.equal(answer(await endBackground(client)), 8);
		assert.match(answer(await bashList(client)).text, /^0 of at most 8 running\./);
		assert.match(answer(await bashOutput(client, { id: stubborn })).text, /ended by signal KILL \(exit code 137\)/);
	});

	it("the cap holds when nine start at once: eight start, the ninth is refused in words", async () => {
		client = await fresh();
		const results = await Promise.all(Array.from({ length: 9 }, (_, i) => bashBackground(client, { command: `echo q${i + 1}; sleep 60` }, AT)));
		assert.equal(results.filter((result) => result.ok).length, 8, JSON.stringify(results));
		const refusals = results.filter((result) => !result.ok);
		assert.equal(refusals.length, 1, JSON.stringify(results));
		refused(refusals[0], "limit", /^8 background processes already run in this run's box, the most at once \(8\): end one with bash_signal/);
		assert.match(answer(await bashList(client)).text, /^8 of at most 8 running\./);
		assert.equal(answer(await endBackground(client)), 8);
	});

	it("bash: output and exit code, 120 s by default, a timeout kills the command and what it started", async () => {
		const ran = answer(await bash(client, { command: "echo a; echo b >&2; pwd", ...AT }));
		assert.deepEqual([ran.output, ran.exitCode, ran.error, ran.timeoutMs], ["a\nb\n/tmp\n", 0, undefined, 120_000]);
		const failed = answer(await bash(client, { command: "echo nope; exit 3", ...AT }));
		assert.deepEqual([failed.output, failed.error], ["nope\n", "Command exited with code 3"]);
		const begun = Date.now();
		const slow = answer(await bash(client, { command: "echo $$ > slow.pid; sleep 600 & echo started; wait", timeoutMs: 1_500, ...AT }));
		assert.ok(Date.now() - begun < 20_000);
		assert.deepEqual([slow.timedOut, slow.error, slow.output], [true, "Command timed out after 1.5 seconds", "started\n"]);
		const pid = Number(answer(await bash(client, { command: "cat slow.pid", ...AT })).output.trim());
		assert.equal(await alive(pid), false, "the timed-out shell is gone");
		assert.equal(answer(await bash(client, { command: SLEEPS, ...AT })).output.trim(), "none", "and the sleep it started");
		// A shell ending leaves nothing behind it: what it started with & is ended with it.
		answer(await bash(client, { command: "sleep 300 &", ...AT }));
		assert.equal(answer(await bash(client, { command: SLEEPS, ...AT })).output.trim(), "none");
		refused(await bash(client, { command: "true", cwd: "/nowhere" }), "not_found", /\/nowhere/);
	});

	it("bash keeps the end of a long output and saves the whole of it to a file in the computer", async () => {
		const long = answer(await bash(client, { command: "seq 1 100000", ...AT }));
		assert.equal(long.output, `${Array.from({ length: 2000 }, (_, i) => i + 98_001).join("\n")}\n`);
		const [full, truncated] = long.diagnostics;
		const path = full.message.replace(/^Full output: /, "");
		assert.match(path, /^\/tmp\/agentrun-bash\//);
		assert.equal(truncated.message, `Output truncated to its end: 98000 lines, ${588_895 - Buffer.byteLength(long.output)} bytes dropped`);
		assert.equal(answer(await bash(client, { command: `wc -c < ${path}; tail -n 1 ${path}`, ...AT })).output, "588895\n100000\n");
	});
});
