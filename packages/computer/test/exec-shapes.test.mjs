// The exec shapes framedExec alone doesn't reach, each through its helper and the exec pre-check on a fake vendor of
// real processes on this machine: split calls whose events are server-sent events (`sse`, src/hosted/rest.ts), one
// terminal (`ptyPieces`, src/hosted/pty-exec.ts) and a start with no stdin call (`fifoStdin`, src/hosted/framed-exec.ts).
// Then the SSE reader's own rules.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { checkExecStream, formatExecStream } from "../dist/conformance/exec-stream.js";
import { FIFO_STDIN } from "../dist/hosted/framed-exec.js";
import { sse } from "../dist/hosted/rest.js";
import { fakeExecHost } from "./fake-exec-host.mjs";
import { fakeTerminals, HAS_SCRIPT, ptyExec } from "./fake-terminal.mjs";
import { fifoExec, sseExec, textVendor } from "./fake-text-host.mjs";

const QUICK = { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 };
/** The pid wrapper and its kill read /proc/<pid>/stat, which a Linux machine has; macOS has no /proc. */
const HAS_PROC = existsSync("/proc/self/stat");

/** The pre-check over exec, every check named in the failure. */
async function precheck(exec) {
	const report = await checkExecStream({ descriptor: { id: "fake" }, exec }, "machine-1", QUICK);
	assert.equal(report.pass, true, formatExecStream(report));
}

test("split calls whose events are server-sent events (Together's shape), read by sse, pass every check of the exec pre-check", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const local = fakeExecHost();
	const vendor = await textVendor(local);
	t.after(async () => {
		local.stopAll();
		await vendor.close();
	});
	await precheck(sseExec(vendor.base));
});

test("a start that streams server-sent events with no stdin call (Render's shape), on fifoStdin, passes every check of the exec pre-check", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const local = fakeExecHost();
	const vendor = await textVendor(local);
	t.after(async () => {
		local.stopAll();
		await vendor.close();
	});
	await precheck(fifoExec(vendor.base));
	assert.ok(!vendor.requests.some((request) => request.endsWith("/stdin")), "no write call: every write was a run of its own");
	const fifos = local.calls.filter(({ argv }) => argv[2] === FIFO_STDIN).flatMap(({ argv }) => [argv[4], `${argv[4]}.0`]);
	assert.ok(fifos.length > 0);
	assert.deepEqual(
		fifos.filter((path) => existsSync(path)),
		[],
		"each process's sh took its fifos with it",
	);
});

test("one terminal on a real pty (echo on, \\n out as \\r\\n, a prompt, stderr merged), on ptyPieces, passes every check of the exec pre-check and leaves no fifo behind", async (t) => {
	if (!HAS_PROC || !HAS_SCRIPT) return t.skip("needs /proc and util-linux's script");
	const tmp = mkdtempSync(join(tmpdir(), "computer-pty-"));
	const terminals = fakeTerminals({ tmp });
	t.after(async () => {
		await terminals.stopAll();
		rmSync(tmp, { recursive: true, force: true });
	});
	await precheck(ptyExec(terminals));
	// Each sh takes its fifos with it as it ends, a moment after its terminal closes.
	for (let at = 0; at < 100 && readdirSync(tmp).length > 0; at++) await pause(20);
	assert.deepEqual(readdirSync(tmp), []);
});

/** A body of these chunks, as they come. */
const bodyOf = (...chunks) =>
	(async function* () {
		for (const chunk of chunks) yield typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
	})();

test("sse reads events as the standard says: comments, event, id and retry, many data lines, \\r, \\n and \\r\\n ends, and a split character", async () => {
	const euro = Buffer.from("data: €\n\n");
	const got = [];
	for await (const event of sse(
		bodyOf("﻿retry: 2500\n: keep-alive\n\nid: 7\nevent: exit\ndata: {\"exitCode\":0}\n\n", "data: one\r\ndata:two\r", "\ndata\r\r", euro.subarray(0, 7), euro.subarray(7), "id: 8\nretry: soon\ndata: cut off at the end"),
	))
		got.push(event);
	assert.deepEqual(got, [
		{ event: "exit", data: '{"exitCode":0}', id: "7", retry: 2500 },
		{ event: "message", data: "one\ntwo\n", id: "7", retry: 2500 },
		{ event: "message", data: "€", id: "7", retry: 2500 },
	]);
});
