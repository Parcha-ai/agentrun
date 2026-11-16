// The exec shape framedExec alone doesn't reach: split calls whose events are server-sent events, read by `sse`
// (src/hosted/rest.ts), through the exec pre-check on a Hyperbrowser-shaped fake vendor of real processes on this
// machine. Then the SSE reader's own rules.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { checkExecStream, formatExecStream } from "../dist/conformance/exec-stream.js";
import { sse } from "../dist/hosted/rest.js";
import { fakeExecHost } from "./fake-exec-host.mjs";
import { sseExec, textVendor } from "./fake-text-host.mjs";

const QUICK = { longMs: 2_000, stepMs: 5_000, largeBytes: 1024 * 1024, largeMs: 30_000, unreadMs: 1_000 };
/** The pre-check's probes read /proc/<pid>/status, which a Linux machine has; macOS has no /proc. */
const HAS_PROC = existsSync("/proc/self/stat");

test("Hyperbrowser's process API (base64 output as server-sent events, `system` lines among them), read by sse, passes every check of the exec pre-check", async (t) => {
	if (!HAS_PROC) return t.skip("no /proc here");
	const local = fakeExecHost();
	const vendor = await textVendor(local);
	t.after(async () => {
		local.stopAll();
		await vendor.close();
	});
	const report = await checkExecStream({ descriptor: { id: "fake" }, exec: sseExec(vendor.base) }, "machine-1", QUICK);
	assert.equal(report.pass, true, formatExecStream(report));
	assert.ok(vendor.requests.some((request) => request.startsWith("DELETE /sandbox/processes/")), "kill went through the vendor's call");
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
		bodyOf("﻿retry: 2500\n: keepalive\n\nid: 7\nevent: done\ndata: {\"exit_code\":0}\n\n", "data: one\r\ndata:two\r", "\ndata\r\r", euro.subarray(0, 7), euro.subarray(7), "id: 8\nretry: soon\ndata: cut off at the end"),
	))
		got.push(event);
	assert.deepEqual(got, [
		{ event: "done", data: '{"exit_code":0}', id: "7", retry: 2500 },
		{ event: "message", data: "one\ntwo\n", id: "7", retry: 2500 },
		{ event: "message", data: "€", id: "7", retry: 2500 },
	]);
});

test("sse gives an event whose blank line ends at a \\r that ends a chunk at once, and reads a \\n that starts the next chunk as that \\r's", async () => {
	let release = () => {};
	const released = new Promise((done) => (release = done));
	const events = sse(
		(async function* () {
			yield Buffer.from("data: ready\r\r");
			await released;
			yield Buffer.from("\ndata: next\n\n");
		})(),
	);
	const first = await Promise.race([events.next(), pause(1_000, { value: "held until more of the body came" })]);
	assert.deepEqual(first.value, { event: "message", data: "ready", id: "" });
	release();
	assert.deepEqual((await events.next()).value, { event: "message", data: "next", id: "" });
	assert.equal((await events.next()).done, true);
});
