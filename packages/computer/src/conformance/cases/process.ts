// process.*: a process outlives the connection that started it, is read by offset, takes stdin, runs in a terminal,
// is signalled and waited on, is listed, and leaves nothing behind when it ends.
import type { DaemonClient } from "../../client.js";
import { listProcesses, readAll } from "../../processes.js";
import type { ProcessStream } from "../../protocol.js";
import type { Capability, Case, CaseContext } from "../types.js";
import { alive, b64, decode } from "./util.js";

const processCase = (name: string, run: Case["run"], needs: Capability[] = ["processes"]): Case => ({
	id: `process.${name}`,
	level: "core",
	group: "process",
	needs,
	run,
});
const TICKER = ["sh", "-c", "i=0; while true; do echo tick $i; i=$((i+1)); sleep 0.2; done"];

/** Reads a stream from offset until what was read holds want; returns it and where the stream now ends. */
async function readUntil(t: CaseContext, client: DaemonClient, id: string, stream: ProcessStream, offset: number, want: string) {
	let text = "";
	let at = offset;
	await t.until(async () => {
		const read = await t.call("process.read", { id, stream, offset: at, waitMs: 1000 }, client);
		text += decode(read.data);
		at = read.nextOffset;
		if (!text.includes(want) && read.exited) throw new Error(`${id} ${stream} ended without ${JSON.stringify(want)}: ${JSON.stringify(text)}`);
		return text.includes(want);
	}, `${id} ${stream} to show ${JSON.stringify(want)} (it showed ${JSON.stringify(text.slice(-200))})`);
	return { text, offset: at };
}

const ticker = (t: CaseContext, client = t.client) => t.call("process.start", { argv: TICKER }, client);

const kill = (t: CaseContext, id: string) => t.call("process.signal", { id, signal: "KILL" });

export const processCases: Case[] = [
	processCase("outlives-connection", async (t) => {
		const a = await t.connect();
		const started = await ticker(t, a.client);
		t.match(started.id, /^\S+$/, "the process's id");
		t.assert(started.pid > 1, `the program's pid, ${started.pid}`);
		await readUntil(t, a.client, started.id, "stdout", 0, "tick 0");
		await a.close();
		const listed = t.ok(await listProcesses(t.client), "listing on another connection");
		const entry = t.present(
			listed.find((p) => p.id === started.id),
			`${started.id} is listed on another connection after the first closed`,
		);
		t.equal(entry.running, true, "running");
		t.equal(entry.pid, started.pid, "pid");
		t.deepEqual(entry.argv.slice(0, 2), ["sh", "-c"], "argv");
		const before = (await t.call("process.read", { id: started.id, stream: "stdout", offset: 0 })).nextOffset;
		const { offset } = await readUntil(t, t.client, started.id, "stdout", before, "tick");
		t.assert(offset > before, "it still ticks after the connection that started it closed");
		await kill(t, started.id);
	}),
	processCase("read-by-offset", async (t) => {
		const started = await ticker(t);
		await readUntil(t, t.client, started.id, "stdout", 0, "tick 0");
		const first = await t.call("process.read", { id: started.id, stream: "stdout", offset: 0 });
		t.match(decode(first.data), /^tick 0\n/, "the stream from offset 0");
		t.equal(first.dropped, 0, "dropped");
		t.assert(first.nextOffset > 0, "nextOffset after the first read");
		const { offset } = await readUntil(t, t.client, started.id, "stdout", first.nextOffset, "tick");
		t.assert(offset > first.nextOffset, `nextOffset grows: ${offset} after ${first.nextOffset}`);
		const again = await t.call("process.read", { id: started.id, stream: "stdout", offset: 0, maxBytes: 7 });
		t.equal(decode(again.data), "tick 0\n", "a second read from offset 0, 7 bytes");
		t.equal(again.nextOffset, 7, "its nextOffset");
		t.refused(await t.client.call("process.read", { id: started.id, stream: "stdout", offset: offset + 1_000_000 }), "a read past the end", ["invalid"]);
		await kill(t, started.id);
	}),
	processCase("stdin", async (t) => {
		const cat = await t.call("process.start", { argv: ["cat"], stdin: true });
		await t.call("process.write", { id: cat.id, data: b64("hello from the suite\n") });
		await t.call("process.write", { id: cat.id, data: b64("bye\n"), close: true });
		t.deepEqual(await t.call("process.wait", { id: cat.id, timeoutMs: t.patience }), { running: false, exitCode: 0, signal: null }, "cat's end after stdin closed");
		const read = t.ok(await readAll(t.client, cat.id, "stdout"), "readAll");
		t.equal(Buffer.from(read.data).toString(), "hello from the suite\nbye\n", "what cat wrote back");
	}),
	processCase("stdin-closed", async (t) => {
		const closed = await t.call("process.start", { argv: ["sh", "-c", "exec 0<&-; echo closed; exec sleep 307"], stdin: true });
		await readUntil(t, t.client, closed.id, "stdout", 0, "closed\n");
		t.refused(await t.client.call("process.write", { id: closed.id, data: b64("x\n") }), "a write to a program that closed its stdin, which must fail at once", ["invalid"]);
		t.deepEqual(await t.call("process.wait", { id: closed.id, timeoutMs: 0 }), { running: true, exitCode: null, signal: null }, "the program after the failed write: running");
		await kill(t, closed.id);
		t.deepEqual(await t.call("process.wait", { id: closed.id, timeoutMs: t.patience }), { running: false, exitCode: null, signal: "KILL" }, "wait after KILL");
	}),
	processCase("pty", async (t) => {
		const sh = await t.call("process.start", { argv: ["sh"], pty: { cols: 80, rows: 24 } });
		let offset = 0;
		await t.call("process.write", { id: sh.id, data: b64("echo pty-$((6*7))\n") });
		({ offset } = await readUntil(t, t.client, sh.id, "pty", offset, "pty-42"));
		await t.call("process.write", { id: sh.id, data: b64("stty size\n") });
		({ offset } = await readUntil(t, t.client, sh.id, "pty", offset, "24 80"));
		await t.call("process.resize", { id: sh.id, cols: 132, rows: 43 });
		await t.call("process.write", { id: sh.id, data: b64("stty size\n") });
		({ offset } = await readUntil(t, t.client, sh.id, "pty", offset, "43 132"));
		await t.call("process.write", { id: sh.id, data: b64("exit 5\n") });
		t.deepEqual(await t.call("process.wait", { id: sh.id, timeoutMs: t.patience }), { running: false, exitCode: 5, signal: null }, "the shell's end");
	}),
	processCase(
		"signal",
		async (t) => {
			const started = await ticker(t);
			await readUntil(t, t.client, started.id, "stdout", 0, "tick 0");
			await t.call("process.signal", { id: started.id, signal: "TERM" });
			t.deepEqual(await t.call("process.wait", { id: started.id, timeoutMs: t.patience }), { running: false, exitCode: null, signal: "TERM" }, "wait after TERM");
			const entry = t.present(
				t.ok(await listProcesses(t.client), "process.list").find((p) => p.id === started.id),
				`${started.id} is listed after it ended`,
			);
			t.deepEqual([entry.running, entry.signal], [false, "TERM"], "the listing after TERM");
			t.assert(entry.endedAt !== null && entry.endedAt >= entry.startedAt, "endedAt after startedAt");
			t.deepEqual(await t.call("process.signal", { id: started.id, signal: "KILL" }), {}, "a signal to a process that has ended");
			await t.until(async () => (await t.exec(["sh", "-c", alive([started.pid])])).out === "", `pid ${started.pid} gone`);
		},
		["processes", "exec"],
	),
	processCase("wait", async (t) => {
		const sleeper = await t.call("process.start", { argv: ["sleep", "303"] });
		t.deepEqual(await t.call("process.wait", { id: sleeper.id, timeoutMs: 0 }), { running: true, exitCode: null, signal: null }, "wait with timeoutMs 0 on a running process");
		t.deepEqual(await t.call("process.wait", { id: sleeper.id, timeoutMs: 300 }), { running: true, exitCode: null, signal: null }, "wait past its timeout");
		await kill(t, sleeper.id);
		t.deepEqual(await t.call("process.wait", { id: sleeper.id, timeoutMs: t.patience }), { running: false, exitCode: null, signal: "KILL" }, "wait after KILL");
		const three = await t.call("process.start", { argv: ["sh", "-c", "exit 3"] });
		t.deepEqual(await t.call("process.wait", { id: three.id, timeoutMs: t.patience }), { running: false, exitCode: 3, signal: null }, "wait on a program that exits 3");
		t.refused(await t.client.call("process.wait", { id: "no-such-process", timeoutMs: 0 }), "a process that does not exist", ["not_found"]);
	}),
	processCase("list", async (t) => {
		const done = await t.call("process.start", { argv: ["echo", "listed"] });
		const term = await t.call("process.start", { argv: ["sleep", "304"], pty: { cols: 80, rows: 24 } });
		await t.call("process.wait", { id: done.id, timeoutMs: t.patience });
		const listed = t.ok(await listProcesses(t.client), "listProcesses");
		const at = (id: string) => listed.findIndex((p) => p.id === id);
		t.assert(at(done.id) >= 0 && at(term.id) > at(done.id), "both are listed, in start order");
		const ended = listed[at(done.id)];
		const running = listed[at(term.id)];
		t.deepEqual([ended?.argv, ended?.running, ended?.exitCode, ended?.pty], [["echo", "listed"], false, 0, false], "the ended process");
		t.deepEqual([running?.argv, running?.running, running?.pty, running?.pid], [["sleep", "304"], true, true, term.pid], "the running one, in a terminal");
		// Pages may be any size: follow next while truncated, then the page from the last next is empty.
		let page = await t.call("process.list", {});
		const paged = [...page.processes];
		for (let pages = 1; page.truncated; pages++) {
			t.assert(pages <= listed.length + 1, `process.list still truncated after ${pages} pages for ${listed.length} processes`);
			t.assert(Number.isSafeInteger(page.next), `next is where the page after starts: ${JSON.stringify(page.next)}`);
			page = await t.call("process.list", { from: page.next });
			paged.push(...page.processes);
		}
		t.deepEqual(
			paged.map((p) => p.id),
			listed.map((p) => p.id),
			"the processes paged by from and next, in start order",
		);
		t.assert(Number.isSafeInteger(page.next), `next is where a page after would start: ${JSON.stringify(page.next)}`);
		t.deepEqual((await t.call("process.list", { from: page.next })).processes, [], "the page from next, after the last");
		await kill(t, term.id);
	}),
	processCase(
		"guard-killed",
		async (t) => {
			// It kills its guard only once the start has returned: a guard killed before it reports the pid fails the start.
			const rogue = await t.call("process.start", { argv: ["sh", "-c", "read go; sleep 305 & echo $$ $!; kill -9 $PPID; wait"], stdin: true });
			await t.call("process.write", { id: rogue.id, data: b64("go\n") });
			const { text } = await readUntil(t, t.client, rogue.id, "stdout", 0, "\n");
			const pids = text.trim().split(/\s+/).map(Number);
			t.equal(pids.length, 2, `two pids from ${JSON.stringify(text)}`);
			t.equal(pids[0], rogue.pid, "the program's pid");
			t.equal((await t.call("process.wait", { id: rogue.id, timeoutMs: t.patience })).running, false, "running, after it killed its own guard");
			await t.until(async () => (await t.exec(["sh", "-c", alive(pids)])).out === "", `pids ${pids.join(" ")} gone`);
		},
		["processes", "exec"],
	),
];
