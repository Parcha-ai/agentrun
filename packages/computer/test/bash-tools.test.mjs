// bash and the five background tools on computerd's process.* calls, against the fake computer (fake-computer.mjs): a
// table of programs the test gives, standing in for what the command does in a computer. What each call asks computerd
// for, and the words a model reads back. The same calls on a real Docker computer are docker/bash-tools.docker.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import * as computer from "../dist/index.js";
import { fakeComputers } from "./fake-computer.mjs";

const {
	bash,
	bashBackground,
	bashOutput,
	bashInput,
	bashSignal,
	bashList,
	endBackground,
	shellPermission,
	BASH_TOOL,
	BACKGROUND_TOOL_DEFINITIONS,
} = computer;

/** A program that writes `output` and exits with `code`. */
const exits = (output = "", code = 0) => ({ start: (p) => (p.write(output), p.end({ exitCode: code })) });
/** A program that writes `output` and runs until a signal ends it. */
const runs = (output = "", more = {}) => ({ start: (p) => p.write(output), ...more });

/**
 * A computer whose shell runs `commands` (each command's program, by the command a call gives; any other exits 0 with
 * nothing). `noBash`: the computer has sh alone. Answers its client and its daemon's record.
 */
async function machine(t, commands = {}, { noBash = false, ...options } = {}) {
	const fake = fakeComputers({
		...options,
		programs: (argv) => {
			if (noBash && argv[0] === "bash") return { refuse: ["not_found", "bash is not on PATH (/usr/bin:/bin) in this computer"] };
			const program = commands[argv.at(-1)];
			return typeof program === "function" ? program(argv) : (program ?? exits());
		},
	});
	const made = await fake.provider.create({ image: "fake", lifetimeMs: 60_000, network: "none" });
	assert.equal(made.ok, true, JSON.stringify(made));
	const connected = await fake.provider.connect(made.value);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	t.after(() => connected.value.close());
	return { client: connected.value.client, daemon: fake.daemon(made.value.name) };
}

/** A call's answer, which must be one: its text and details. */
const answer = (result) => {
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.value;
};
/** A call's refusal, which must be one: its code and words. */
const refused = (result, code, words) => {
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result));
	assert.match(result.error.message, words);
};
const starts = (daemon) => daemon.requests.filter(([method]) => method === "process.start").map(([, params]) => params);

test("demo: start `echo started; sleep 30; echo done` in the background, list it, signal it and see it gone, its output read back", async (t) => {
	const command = "echo started; sleep 30; echo done";
	const { client, daemon } = await machine(t, { [command]: runs("started\n") });
	const started = answer(await bashBackground(client, { command }));
	assert.equal(started.text, 'Started background process 1 (process group 100). Its output goes to background/1/output.log in work/: read it with bash_output {"id": "1"}, write its stdin with bash_input, end it with bash_signal.');
	assert.deepEqual(started.details, { id: "1", log: "background/1/output.log", pid: 100 });
	assert.match(answer(await bashList(client)).text, /^1 of at most 8 running\.\n1: is running; 8 bytes of output; started \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ; "echo started; sleep 30; echo done"$/);
	assert.equal(answer(await bashSignal(client, { id: "1", signal: "TERM" })).text, "Sent TERM to background process 1: it ended by signal TERM (exit code 143).");
	assert.match(answer(await bashList(client)).text, /^0 of at most 8 running\.\n1: ended by signal TERM \(exit code 143\); 8 bytes of output;/);
	const output = answer(await bashOutput(client, { id: "1" }));
	assert.equal(output.text, "Background process 1 ended by signal TERM (exit code 143). Output bytes 0 to 8 of 8, the end.\n\nstarted\n");
	assert.deepEqual(output.details, { id: "1", state: "exited", exit_code: 143, signal: "TERM", offset: 0, next_offset: 8, size: 8 });
	// The log is in the run's files: computerd writes it, and bash_output read it from computerd, not from the file.
	assert.equal(daemon.contents.get("/workspace/background/1/output.log").toString(), "started\n");
	assert.ok(daemon.requests.some(([method, params]) => method === "process.read" && params.stream === "log"), "read from the log");
	// One fresh shell, bash, from the run's folder, its stdin a pipe bash_input writes, stderr in the same stream as
	// stdout; computerd runs it until its group is empty, keeps what leaves the group, and writes its log.
	const [params] = starts(daemon);
	assert.deepEqual([params.argv[0], params.argv[1], params.argv[3], params.argv[4], params.argv[5]], ["bash", "-c", "agentrun-background", "1", command]);
	assert.match(params.argv[2], /2>&1/);
	assert.doesNotMatch(params.argv[2], /\bwait\b/);
	assert.deepEqual([params.cwd, params.stdin, params.pty, params.log, params.waitGroup, params.orphans], ["/workspace", true, undefined, "/workspace/background/1/output.log", true, "keep"]);
});

test("ids are the run's own, the first free one, and skip a number whose folder is there; a link at work/background starts nothing", async (t) => {
	const { client, daemon } = await machine(t, { "sleep 60": runs() });
	answer(await bash(client, { command: "true" }));
	daemon.tree.set("/workspace/background", "dir");
	daemon.tree.set("/workspace/background/1", "dir");
	daemon.tree.set("/workspace/background/3", "symlink");
	const ids = [];
	for (let i = 0; i < 3; i++) ids.push(answer(await bashBackground(client, { command: "sleep 60" })).details.id);
	assert.deepEqual(ids, ["2", "4", "5"], "1 and 3 are taken in the folder, and bash's own process is no background one");
	assert.deepEqual(starts(daemon).slice(1).map((p) => p.log), ["/workspace/background/2/output.log", "/workspace/background/4/output.log", "/workspace/background/5/output.log"]);
	const { client: linked, daemon: other } = await machine(t);
	other.tree.set("/workspace/background", "symlink");
	refused(await bashBackground(linked, { command: "sleep 60" }), "invalid", /^work\/background is a link, so no background process starts: remove it, and its logs go in a directory of their own again$/);
	assert.equal(starts(other).length, 0, "nothing started");
});

test("start, then page by byte offset, then the exit code; a page never splits a character; an unknown id is refused in words", async (t) => {
	const command = "printf 'one\\n'; sleep 0.2; printf 'two\\n'; printf '\\342\\202\\254!'; exit 3";
	const { client } = await machine(t, { [command]: exits("one\ntwo\n€!", 3) });
	answer(await bashBackground(client, { command }));
	assert.equal(answer(await bashOutput(client, { id: "1", max_bytes: 4 })).text, "Background process 1 exited with code 3. Output bytes 0 to 4 of 12; call again with offset 4 for the next part.\n\none\n");
	// Five bytes asked from 4: "two\n" and the first byte of the euro sign, which is left for the next page.
	assert.equal(answer(await bashOutput(client, { id: "1", offset: 4, max_bytes: 5 })).text, "Background process 1 exited with code 3. Output bytes 4 to 8 of 12; call again with offset 8 for the next part.\n\ntwo\n");
	assert.equal(answer(await bashOutput(client, { id: "1", offset: 8 })).text, "Background process 1 exited with code 3. Output bytes 8 to 12 of 12, the end.\n\n€!");
	assert.equal(answer(await bashOutput(client, { id: 1, offset: 12 })).text, "Background process 1 exited with code 3. No output past byte 12 (the log has 12 bytes).");
	// Past the end too: computerd refuses the read, and the answer is the same words.
	assert.equal(answer(await bashOutput(client, { id: "1", offset: 20 })).text, "Background process 1 exited with code 3. No output past byte 20 (the log has 12 bytes).");
	refused(await bashOutput(client, { id: "99" }), "not_found", /^there is no background process 99 in this run: bash_list shows them$/);
	refused(await bashSignal(client, { id: "1", signal: "KILL" }), "invalid", /^background process 1 exited with code 3, so no signal was sent$/);
	refused(await bashInput(client, { id: "1", text: "late\n" }), "invalid", /^background process 1 exited with code 3, so it takes no input$/);
	// A page smaller than the one character it starts with reads nothing, and says what to ask.
	refused(await bashOutput(client, { id: "1", offset: 8, max_bytes: 2 }), "invalid", /the character at byte 8 of background process 1's output is longer than max_bytes 2: ask again with max_bytes 4 or more/);
	refused(await bashOutput(client, { id: "abc" }), "invalid", /^"abc" is no background process id: an id is the number bash_background answered, such as "1" \(bash_list shows them\)$/);
	refused(await bashOutput(client, { id: "../1" }), "invalid", /is no background process id/);
	refused(await bashOutput(client, { id: "1", max_bytes: 49_153 }), "invalid", /^max_bytes is a whole number from 1 to 49,152$/);
	refused(await bashOutput(client, { id: "1", offset: -1 }), "invalid", /^offset is a whole number from 0 to 16,777,216$/);
	refused(await bashOutput(client, { id: "1", offset: 16 * 1024 * 1024 + 1 }), "invalid", /^offset is a whole number from 0 to 16,777,216$/);
});

test("a running process's page is all of it so far, ends on a whole character, and a read at its end says to call again", async (t) => {
	const { client } = await machine(t, { "server &": runs(Buffer.from([0x61, 0x62, 0xe2, 0x82])) });
	answer(await bashBackground(client, { command: "server &" }));
	assert.equal(answer(await bashOutput(client, { id: "1" })).text, "Background process 1 is running. Output bytes 0 to 2 of 4; call again with offset 2 for the next part.\n\nab");
	const { client: other } = await machine(t, { "sleep 60 >/dev/null 2>&1 & echo parent done": runs("parent done\n") });
	answer(await bashBackground(other, { command: "sleep 60 >/dev/null 2>&1 & echo parent done" }));
	assert.equal(answer(await bashOutput(other, { id: "1" })).text, "Background process 1 is running. Output bytes 0 to 12 of 12, all of it so far; call again with offset 12 for what comes next.\n\nparent done\n");
	assert.equal(answer(await bashOutput(other, { id: "1", offset: 12 })).text, "Background process 1 is running. No output past byte 12 (the log has 12 bytes); call again later with the same offset for what comes next.");
});

test("stdin reaches a `read` loop, line by line; close: true ends its input; a closed stdin, a stuck reader and the limits are said in words", async (t) => {
	const loop = "while read -r line; do echo \"got $line\"; [ \"$line\" = stop ] && exit 0; done; echo eof";
	const cat = 'cat; echo " (end of input)"';
	let held = "";
	const { client, daemon } = await machine(t, {
		[loop]: runs("", {
			input: (text, p) => {
				for (const line of text.split("\n").slice(0, -1)) {
					p.write(`got ${line}\n`);
					if (line === "stop") p.end({ exitCode: 0 });
				}
			},
		}),
		[cat]: runs("", {
			input: (text, p, close) => {
				held += text;
				if (close) p.write(`${held} (end of input)\n`), p.end({ exitCode: 0 });
			},
		}),
		"cat > /dev/null": runs(),
		"sleep 600": runs("", { stuck: true }),
		"exec 0<&-; sleep 600": runs("", { unread: true }),
	});
	answer(await bashBackground(client, { command: loop }));
	assert.equal(answer(await bashInput(client, { id: "1", text: "hello\n" })).text, "Wrote 6 bytes to background process 1's stdin. Read what it answers with bash_output.");
	assert.equal(answer(await bashOutput(client, { id: "1" })).text, "Background process 1 is running. Output bytes 0 to 10 of 10, all of it so far; call again with offset 10 for what comes next.\n\ngot hello\n");
	answer(await bashInput(client, { id: "1", text: "stop\n" }));
	assert.equal(answer(await bashOutput(client, { id: "1", offset: 10 })).text, "Background process 1 exited with code 0. Output bytes 10 to 19 of 19, the end.\n\ngot stop\n");
	answer(await bashBackground(client, { command: cat }));
	const closed = answer(await bashInput(client, { id: "2", text: "abc", close: true }));
	assert.equal(closed.text, "Wrote 3 bytes to background process 2's stdin, then closed it. Read what it answers with bash_output.");
	assert.deepEqual(closed.details, { id: "2", bytes: 3, closed: true });
	assert.equal(answer(await bashOutput(client, { id: "2" })).text, "Background process 2 exited with code 0. Output bytes 0 to 19 of 19, the end.\n\nabc (end of input)\n");
	answer(await bashBackground(client, { command: "cat > /dev/null" }));
	answer(await bashInput(client, { id: "3", text: "", close: true }));
	refused(await bashInput(client, { id: "3", text: "more\n" }), "invalid", /^background process 3's stdin is closed: an earlier bash_input closed it$/);
	answer(await bashBackground(client, { command: "sleep 600" }));
	refused(await bashInput(client, { id: "4", text: "x\n" }), "timeout", /^process 4 did not take its input: .+ \(a process that does not read its stdin fills its pipe at 64 KiB\)$/);
	refused(await bashInput(client, { id: "3", text: "x".repeat(64 * 1024 + 1) }), "invalid", /^text is at most 64 KiB a call; send it in parts$/);
	refused(await bashInput(client, { id: "3", text: "" }), "invalid", /^text is what to write: give some, or close: true to close stdin$/);
	// Bytes go as base64 now, so a NUL is only a byte, as any other.
	answer(await bashBackground(client, { command: loop }));
	answer(await bashInput(client, { id: "5", text: "a\0b\n" }));
	// Any other input the computer refuses is said as today's: what it said, and the pipe's 64 KiB.
	answer(await bashBackground(client, { command: "exec 0<&-; sleep 600" }));
	refused(await bashInput(client, { id: "6", text: "x\n" }), "invalid", /^process 6 did not take its input: process p6 no longer reads its input: .+ \(a process that does not read its stdin fills its pipe at 64 KiB\)$/);
	assert.deepEqual(daemon.inputs.map(([id, text, close]) => [id, text, close]), [
		["p1", "hello\n", false],
		["p1", "stop\n", false],
		["p2", "abc", true],
		["p3", "", true],
		["p5", "a\0b\n", false],
	]);
});

test("a signal ends it: INT as Ctrl-C, KILL where TERM is ignored; HUP is refused; an exit code past 128 is said as its signal", async (t) => {
	const { client, daemon } = await machine(t, {
		"sleep 30; echo done": runs(),
		"trap '' TERM; echo stubborn; sleep 30": runs("stubborn\n", { signal: (name) => name === "TERM" }),
		"sleep 31": runs(),
		"kill -INT $$": exits("", 130),
	});
	answer(await bashBackground(client, { command: "sleep 30; echo done" }));
	const int = answer(await bashSignal(client, { id: "1", signal: "INT" }));
	assert.equal(int.text, "Sent INT to background process 1: it ended by signal INT (exit code 130).");
	assert.deepEqual(int.details, { id: "1", signal: "INT", state: "exited", exit_code: 130 });
	answer(await bashBackground(client, { command: "trap '' TERM; echo stubborn; sleep 30" }));
	const before = Date.now();
	assert.equal(answer(await bashSignal(client, { id: "2", signal: "TERM" })).text, "Sent TERM to background process 2: it is running. Send KILL to end it at once.");
	assert.ok(Date.now() - before >= 1_900, "it waited up to 2 s for the end");
	assert.equal(answer(await bashSignal(client, { id: "2", signal: "KILL" })).text, "Sent KILL to background process 2: it ended by signal KILL (exit code 137).");
	refused(await bashSignal(client, { id: "2", signal: "HUP" }), "invalid", /^signal is one of TERM, INT, KILL$/);
	answer(await bashBackground(client, { command: "sleep 31" }));
	assert.equal(answer(await bashSignal(client, { id: "3", signal: " sigterm " })).text, "Sent TERM to background process 3: it ended by signal TERM (exit code 143).");
	answer(await bashBackground(client, { command: "kill -INT $$" }));
	assert.match(answer(await bashOutput(client, { id: "4" })).text, /^Background process 4 ended by signal INT \(exit code 130\)\./);
	assert.deepEqual(daemon.signals, [["p1", "INT"], ["p2", "TERM"], ["p2", "KILL"], ["p3", "TERM"]]);
});

test("the per-run cap (8 at once) refuses in plain words and starts nothing; endBackground ends every one, TERM then KILL", async (t) => {
	const commands = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`echo p${i + 1}; sleep 60`, runs(`p${i + 1}\n`, i === 7 ? { signal: (name) => name === "TERM" } : {})]));
	const { client, daemon } = await machine(t, commands);
	for (const command of Object.keys(commands)) answer(await bashBackground(client, { command }));
	refused(await bashBackground(client, { command: "echo one too many" }), "limit", /^8 background processes already run in this run's box, the most at once \(8\): end one with bash_signal \(bash_list shows them\), or wait for one to exit, then start this again\.$/);
	assert.equal(starts(daemon).length, 8, "the refused one started nothing");
	assert.match(answer(await bashList(client)).text, /^8 of at most 8 running\./);
	assert.equal(await endBackground(client).then(answer), 8);
	assert.deepEqual(daemon.signals, [...Array.from({ length: 8 }, (_, i) => [`p${i + 1}`, "TERM"]), ["p8", "KILL"]]);
	assert.match(answer(await bashList(client)).text, /^0 of at most 8 running\./);
	assert.equal(await endBackground(client).then(answer), 0, "none left to end");
});

test("the cap holds when nine start at once: eight start and the ninth is refused in the same words, the check and the start taking turns", async (t) => {
	const commands = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`echo q${i + 1}; sleep 60`, runs(`q${i + 1}\n`)]));
	const { client, daemon } = await machine(t, commands);
	const results = await Promise.all(Object.keys(commands).map((command) => bashBackground(client, { command })));
	const started = results.filter((result) => result.ok);
	const refusals = results.filter((result) => !result.ok);
	assert.equal(started.length, 8, JSON.stringify(results));
	assert.equal(refusals.length, 1, JSON.stringify(results));
	refused(refusals[0], "limit", /^8 background processes already run in this run's box, the most at once \(8\): end one with bash_signal \(bash_list shows them\), or wait for one to exit, then start this again\.$/);
	assert.equal(starts(daemon).length, 8, "the refused one started nothing");
	assert.match(answer(await bashList(client)).text, /^8 of at most 8 running\./);
});

test("a log keeps its first 16 MiB, and the process runs on past the cap", async (t) => {
	const { client, daemon } = await machine(t, { "yes | head -c 40": exits("0123456789abcdefghijklmnopqrstuvwxyz!?#$", 4) }, { logBytes: 16, ringBytes: 8 });
	answer(await bashBackground(client, { command: "yes | head -c 40" }));
	const read = answer(await bashOutput(client, { id: "1", offset: 13 }));
	assert.equal(read.text, "Background process 1 exited with code 4. Output bytes 13 to 16 of 16, the end. Its log reached the 16 MiB cap, so later output was dropped.\n\ndef");
	assert.deepEqual(read.details, { id: "1", state: "exited", exit_code: 4, offset: 13, next_offset: 16, size: 16, capped: true });
	assert.equal(daemon.contents.get("/workspace/background/1/output.log").toString(), "0123456789abcdef");
	assert.match(answer(await bashList(client)).text, /\n1: exited with code 4; 16 bytes of output;/);
});

test("tty: the command runs on a terminal; its output is the terminal's; close is Ctrl-D; INT goes to computerd as Ctrl-C, its note said", async (t) => {
	const { client, daemon } = await machine(t, {
		tty: exits("/dev/pts/0\r\n"),
		"read -r -p 'name? ' n; echo \"hello $n\"": runs("name? ", { input: (text, p) => (p.write(`${text.replace(/\n/g, "\r\n")}`), text.includes("\n") && (p.write(`hello ${text.trim()}\r\n`), p.end({ exitCode: 0 }))) }),
		"cat": runs(),
		"sh -i": runs("$ ", { signal: (name) => name === "INT", note: "the terminal has no foreground group; INT went to the program's own group" }),
	});
	const started = answer(await bashBackground(client, { command: "tty", tty: true }));
	assert.match(started.text, /^Started background process 1 \(process group 100\) on a terminal\. /);
	assert.deepEqual(started.details, { id: "1", log: "background/1/output.log", pid: 100, tty: true });
	assert.deepEqual(starts(daemon)[0].pty, { cols: 80, rows: 24 });
	assert.equal(starts(daemon)[0].stdin, undefined, "a terminal is its stdin");
	assert.equal(answer(await bashOutput(client, { id: "1" })).text, "Background process 1 exited with code 0. Output bytes 0 to 12 of 12, the end.\n\n/dev/pts/0\r\n");
	assert.equal(daemon.contents.get("/workspace/background/1/output.log").toString(), "/dev/pts/0\r\n", "the log holds what the terminal showed");
	answer(await bashBackground(client, { command: "read -r -p 'name? ' n; echo \"hello $n\"", tty: true }));
	assert.equal(answer(await bashInput(client, { id: "2", text: "bob\n" })).text, "Wrote 4 bytes to background process 2's stdin. Read what it answers with bash_output.");
	assert.equal(answer(await bashOutput(client, { id: "2" })).text, "Background process 2 exited with code 0. Output bytes 0 to 22 of 22, the end.\n\nname? bob\r\nhello bob\r\n");
	// A terminal has no stdin to close: close: true types Ctrl-D, twice after a partial line (the first ends the line).
	answer(await bashBackground(client, { command: "cat", tty: true }));
	assert.equal(answer(await bashInput(client, { id: "3", text: "abc\n", close: true })).text, "Wrote 4 bytes to background process 3's stdin, then closed it. Read what it answers with bash_output.");
	answer(await bashInput(client, { id: "3", text: "tail", close: true }));
	answer(await bashInput(client, { id: "3", text: "", close: true }));
	assert.deepEqual(daemon.inputs.filter(([id]) => id === "p3"), [["p3", "abc\n\x04", false], ["p3", "tail\x04\x04", false], ["p3", "\x04", false]]);
	answer(await bashBackground(client, { command: "sh -i", tty: true }));
	assert.equal(answer(await bashSignal(client, { id: "4", signal: "INT" })).text, "Sent INT to background process 4 (the terminal has no foreground group; INT went to the program's own group): it is running. Send KILL to end it at once.");
	assert.match(answer(await bashList(client)).text, /\n4: is running; 2 bytes of output; started [^;]+; "sh -i" \(tty\)/);
});

test("bash_list: every running one first, then the newest that ended, 40 at most; another process in the computer is no background process", async (t) => {
	const { client } = await machine(t, { "server --port 80": runs("up\n"), [`echo ${"x".repeat(200)}\n\tdone`]: exits("x\n") });
	assert.equal(answer(await bashList(client)).text, "No background processes in this run's box: bash_background starts one.");
	assert.deepEqual(answer(await bashList(client)).details, { processes: [] });
	// A foreground bash and a process started by something else are never shown or reached here.
	answer(await bash(client, { command: "true" }));
	const other = await client.call("process.start", { argv: ["sleep", "600"] });
	assert.equal(other.value.id, "p2");
	refused(await bashOutput(client, { id: "1" }), "not_found", /^there is no background process 1 in this run: bash_list shows them$/);
	refused(await bashSignal(client, { id: "2", signal: "KILL" }), "not_found", /^there is no background process 2 in this run/);
	refused(await bashInput(client, { id: "2", text: "x\n" }), "not_found", /^there is no background process 2 in this run/);
	assert.equal(answer(await bashBackground(client, { command: "server --port 80" })).details.id, "1", "the run's own ids, whatever else runs in the computer");
	for (let i = 0; i < 42; i++) answer(await bashBackground(client, { command: `echo ${"x".repeat(200)}\n\tdone` }));
	const listed = answer(await bashList(client));
	const lines = listed.text.split("\n");
	assert.equal(lines[0], "1 of at most 8 running.");
	assert.match(lines[1], /^1: is running; 3 bytes of output; started [^;]+; "server --port 80"$/);
	assert.match(lines[2], /^43: exited with code 0; 2 bytes of output; started [^;]+; "echo x{115}"$/, "the newest that ended, its command on one line, cut at 120 characters");
	assert.equal(lines.length, 1 + 40 + 1);
	assert.match(lines[40], /^5: exited with code 0;/);
	assert.equal(lines[41], "(and 3 older ones that ended)");
	assert.equal(listed.details.running, 1);
	assert.equal(listed.details.processes.length, 40);
	assert.deepEqual(Object.keys(listed.details.processes[0]).sort(), ["command", "id", "size", "started", "state"]);
});

test("bash runs through computerd at the run's folder: stdout and stderr as one, a non-zero exit is its error, sh where there is no bash", async (t) => {
	const { client, daemon } = await machine(t, { "echo hi": exits("hi\n"), "make": exits("cc: error\n", 3) });
	const seen = [];
	const ran = answer(await bash(client, { command: "echo hi", onOutput: (text) => seen.push(text) }));
	assert.deepEqual({ ...ran, id: undefined }, { id: undefined, output: "hi\n", exitCode: 0, signal: null, timedOut: false, diagnostics: [], timeoutMs: 120_000 });
	assert.equal(seen.join(""), "hi\n", "its output as it comes");
	const [params] = starts(daemon);
	assert.deepEqual([params.argv[0], params.argv[1], params.argv[3], params.argv[4]], ["bash", "-c", "agentrun-bash", "echo hi"]);
	assert.match(params.argv[2], /2>&1/);
	assert.equal(params.cwd, "/workspace");
	assert.equal(params.stdin, undefined, "no stdin: a command reads the end of its input at once");
	const failed = answer(await bash(client, { command: "make", cwd: "/src" }));
	assert.equal(failed.error, "Command exited with code 3");
	assert.equal(failed.output, "cc: error\n");
	assert.equal(failed.exitCode, 3);
	assert.equal(starts(daemon)[1].cwd, "/src");
	const { client: plain, daemon: sh } = await machine(t, { "echo hi": exits("hi\n") }, { noBash: true });
	assert.equal(answer(await bash(plain, { command: "echo hi" })).output, "hi\n");
	assert.deepEqual(starts(sh).map((p) => p.argv[0]), ["bash", "sh"], "bash first, then sh");
	refused(await bash(client, { command: "  " }), "invalid", /^command is the shell command to run$/);
});

test("bash's timeout: 120 s by default, the asked one under 600 s, 600 s for more with words; a timeout kills the command and says so", async (t) => {
	const { client, daemon } = await machine(t, { "sleep 30": runs("waiting\n"), true: exits() });
	assert.equal(answer(await bash(client, { command: "true" })).timeoutMs, 120_000);
	assert.equal(answer(await bash(client, { command: "true", timeoutMs: 30_000 })).timeoutMs, 30_000);
	const capped = answer(await bash(client, { command: "true", timeoutMs: 3_000_000 }));
	assert.equal(capped.timeoutMs, 600_000);
	assert.deepEqual(capped.diagnostics, [{ severity: "warn", code: "timeout_capped", message: "bash runs a command for at most 600 s: this one ran with 600 s, not the 3000 s asked. For longer work use bash_background." }]);
	assert.equal(capped.error, undefined);
	const before = Date.now();
	const slow = answer(await bash(client, { command: "sleep 30", timeoutMs: 400 }));
	assert.ok(Date.now() - before < 5_000);
	assert.equal(slow.timedOut, true);
	assert.equal(slow.error, "Command timed out after 0.4 seconds");
	assert.equal(slow.output, "waiting\n");
	assert.deepEqual(daemon.signals, [[slow.id, "KILL"]]);
	for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) refused(await bash(client, { command: "true", timeoutMs }), "invalid", /^Invalid timeout: must be a finite number of seconds$/);
});

test("bash keeps the end of a long output, 2000 lines or 50 KB, says what it dropped, and saves the whole of it to a file in the computer", async (t) => {
	const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}\n`).join("");
	const wide = "y".repeat(60 * 1024);
	const { client, daemon } = await machine(t, { "seq 2500": exits(lines), "wide": exits(wide) });
	const long = answer(await bash(client, { command: "seq 2500" }));
	assert.equal(long.output, Array.from({ length: 2000 }, (_, i) => `line ${i + 501}\n`).join(""));
	const dropped = Buffer.byteLength(lines) - Buffer.byteLength(long.output);
	const [full, truncated] = long.diagnostics;
	assert.match(full.message, /^Full output: \/tmp\/agentrun-bash\/\S+\.log$/);
	assert.deepEqual(full.code, "full_output");
	assert.deepEqual(truncated, { severity: "warn", code: "truncated", message: `Output truncated to its end: 500 lines, ${dropped} bytes dropped` });
	assert.equal(daemon.contents.get(full.message.slice("Full output: ".length)).toString(), lines, "the whole output is in the file");
	const one = answer(await bash(client, { command: "wide" }));
	assert.equal(one.output, "y".repeat(50 * 1024));
	assert.equal(one.diagnostics[1].message, `Output truncated to its end: 0 lines, ${10 * 1024} bytes dropped`);
	const short = answer(await bash(client, { command: "echo" }));
	assert.deepEqual(short.diagnostics, [], "nothing saved for an output within the limits");
});

test("bash aborted: the command is killed and the call is aborted", async (t) => {
	const { client, daemon } = await machine(t, { "sleep 30": runs() });
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	refused(await bash(client, { command: "sleep 30", signal: controller.signal }), "aborted", /^Command aborted$/);
	assert.deepEqual(daemon.signals, [["p1", "KILL"]]);
});

test("the tools' names, parameters and words; the gate: bash: deny refuses all six, bash: ask parks bash, bash_background and bash_input, and the watchers run", () => {
	assert.equal(BASH_TOOL.name, "bash");
	assert.equal(
		BASH_TOOL.description,
		"Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Each command is stopped after 120 s by default, at most 600 s; for longer work use bash_background.",
	);
	assert.deepEqual(BASH_TOOL.parameters, {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to execute" },
			timeout: { type: "number", description: "Timeout in seconds: 120 s by default, at most 600 s; for longer work use bash_background." },
		},
		required: ["command"],
	});
	const tools = Object.fromEntries(BACKGROUND_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
	assert.deepEqual(Object.keys(tools), ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"]);
	assert.deepEqual(Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, [Object.keys(tool.parameters.properties), tool.parameters.required, tool.replay ?? null]])), {
		bash_background: [["command", "tty"], ["command"], null],
		bash_output: [["id", "offset", "max_bytes"], ["id"], "safe"],
		bash_input: [["id", "text", "close"], ["id", "text"], null],
		bash_signal: [["id", "signal"], ["id", "signal"], null],
		bash_list: [[], [], "safe"],
	});
	assert.equal(tools.bash_output.parameters.properties.max_bytes.maximum, 48 * 1024);
	assert.deepEqual(tools.bash_signal.parameters.properties.signal.enum, ["TERM", "INT", "KILL"]);
	// Today's words, byte for byte.
	assert.equal(
		tools.bash_background.description,
		"Start a shell command in the background in the run's box, from its work/, and answer at once with its id. Each call is a fresh shell (bash, else sh). The command runs until it and every child it left in its process group (a server started with &) have exited, bash_signal ends it, or the run ends, which ends it. Its stdout and stderr go together to work/background/<id>/output.log, which the run's files keep: the first 16 MiB of them, later output dropped while it runs on. Its stdin is a pipe that bash_input writes; tty: true gives it a terminal instead. At most 8 run at once in a run's box. Read its output with bash_output, list them with bash_list.",
	);
	assert.equal(
		tools.bash_background.parameters.properties.tty.description,
		"Run it on a terminal (a pty, through script in the box), for a program that needs one: a prompt, a REPL, a progress display. Its log then holds what the terminal shows (your input echoed, lines ending in \\r\\n); bash_input types into the terminal, and bash_signal INT is Ctrl-C to its foreground job.",
	);
	assert.equal(tools.bash_output.description, "Read a background process's output (stdout and stderr together) from a byte offset: at most max_bytes (default and most 48 KiB), with whether it still runs, its exit code once it has ended, the log's size, and the offset to read from next. Start at 0; pass the next offset to read on, also to see what a running process wrote since.");
	assert.equal(tools.bash_input.description, "Write text to a running background process's stdin, as given (end a line with \\n), at most 64 KiB a call. close: true closes its stdin after the text, so the process reads the end of its input. To interrupt it, send bash_signal INT; a control character written here is only a byte.");
	assert.equal(tools.bash_signal.description, "Send a signal to a background process's process group: TERM asks it to stop, INT is Ctrl-C, KILL ends it at once. Answers its state after up to 2 s: a process that handles the signal may run on.");
	assert.equal(tools.bash_list.description, "List this run's background processes: each one's id, whether it runs or how it ended, its output's size and its command's start, every running one first, then the newest that ended (40 at most).");
	const names = ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];
	assert.deepEqual(names.map((name) => shellPermission(name, "deny")), Array(6).fill("deny"));
	assert.deepEqual(names.map((name) => shellPermission(name, "allow")), Array(6).fill("allow"));
	assert.deepEqual(names.map((name) => shellPermission(name, "ask")), ["ask", "ask", "allow", "ask", "allow", "allow"]);
	assert.deepEqual(computer.SHELL_UNDER_ASK, { bash: "ask", bash_background: "ask", bash_output: "allow", bash_input: "ask", bash_signal: "allow", bash_list: "allow" });
	assert.deepEqual(computer.SHELL_TOOLS, names);
});
