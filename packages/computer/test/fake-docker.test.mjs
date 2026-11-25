// The fake docker itself: its processes share their state files, so a call that reads one while another call writes it
// must read a whole file, the one before or the one after, never half of it; and a test reading the logs the calls
// append to reads whole lines, never part of one still being written.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeImageDocker } from "./fake-image-docker.mjs";

const run = promisify(execFile);

test("a docker call that reads the fake's state while others rewrite it reads a whole file", { timeout: 60_000 }, async () => {
	// Enough volumes that each rewrite takes more than one write to the disk.
	const volumes = Array.from({ length: 4_000 }, (_, i) => ({ Name: `v${i}`, Labels: { "x.test/pad": "p".repeat(64) }, Options: [], Driver: "local" }));
	const { program } = fakeDocker({ volumes });
	const calls = [];
	for (let i = 0; i < 24; i += 1) {
		calls.push(run(program, ["volume", "create", `new-${i}`]).then(() => "wrote"));
		calls.push(run(program, ["volume", "ls", "--filter", "label=x.test/pad"]).then(({ stdout }) => stdout.split("\n").filter(Boolean).length));
	}
	const settled = await Promise.allSettled(calls);
	const failed = settled.filter((s) => s.status === "rejected").map((s) => String(s.reason?.stderr ?? s.reason).slice(0, 200));
	assert.deepEqual(failed, [], "every call read a whole state file");
	for (const s of settled) if (typeof s.value === "number") assert.equal(s.value, volumes.length, "a read lists every volume");
});

// A docker call appends its line to the fake's logs while the test reads them. Linux lets a reader see part of a write
// in flight (page by page), so a read can end in part of a line: each case holds a real call of the fake's program with
// part of its line written (as such a read sees it) and reads the log then. The read lists the lines that are whole.
const TORN = fileURLToPath(new URL("./torn-append.cjs", import.meta.url));
/** Runs `program args` with its append to `file` cut after `at` bytes; resolves once that part is in, with go(), which
 *  lets the rest be written, and the call's end. `input` is written to its stdin. */
const tornCall = async (program, args, { file, at = 8, input }) => {
	const dir = mkdtempSync(join(tmpdir(), "computer-torn-"));
	const go = join(dir, "go");
	const child = spawn(program, args, { env: { ...process.env, NODE_OPTIONS: `--require ${TORN}`, TORN_APPEND: file, TORN_APPEND_AT: String(at), TORN_APPEND_GO: go }, stdio: ["pipe", "ignore", "pipe"] });
	const ended = once(child, "exit").finally(() => rmSync(dir, { recursive: true, force: true }));
	let stderr = "";
	const held = new Promise((resolve, reject) => {
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.includes("held\n")) resolve();
		});
		child.on("exit", () => reject(new Error(`the call ended before its append was held: ${stderr}`)));
	});
	if (input !== undefined) child.stdin.write(input);
	await held;
	return { go: () => writeFileSync(go, ""), child, ended };
};

for (const [log, read] of [["calls.jsonl", (fake) => fake.calls()], ["envs.jsonl", (fake) => fake.envs().map((one) => one.args)]]) {
	test(`fakeDocker's ${log}, read while a call's line is half written, lists the whole lines`, { timeout: 60_000 }, async () => {
		const fake = fakeDocker();
		await run(fake.program, ["info"]);
		const call = await tornCall(fake.program, ["ps", "-a"], { file: log });
		try {
			assert.deepEqual(read(fake), [["info"]], "the half-written line is not read");
		} finally {
			call.go();
			await call.ended;
		}
		assert.deepEqual(read(fake), [["info"], ["ps", "-a"]], "the line is read once it is whole");
	});
}

test("fakeDocker's started.jsonl, read while the daemon's process.start line is half written, lists the whole lines", { timeout: 60_000 }, async () => {
	const fake = fakeDocker();
	const params = { argv: ["Xvfb", ":99"] };
	const call = await tornCall(fake.program, ["exec", "-i", "c", "/opt/agentrun/computerd", "stdio"], { file: "started.jsonl", input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "process.start", params })}\n` });
	try {
		assert.deepEqual(fake.started(), [], "the half-written line is not read");
	} finally {
		call.go();
		call.child.stdin.end();
		await call.ended;
	}
	assert.deepEqual(fake.started(), [params], "the line is read once it is whole");
});

test("fakeImageDocker's calls.jsonl, read while a call's line is half written, lists the whole lines", { timeout: 60_000 }, async () => {
	const fake = fakeImageDocker();
	await run(fake.docker, ["image", "inspect", "a"]).catch(() => {});
	const call = await tornCall(fake.docker, ["image", "inspect", "b"], { file: "calls.jsonl" });
	try {
		assert.deepEqual(fake.calls(), [["image", "inspect", "a"]], "the half-written line is not read");
	} finally {
		call.go();
		await call.ended;
	}
	assert.deepEqual(fake.calls(), [["image", "inspect", "a"], ["image", "inspect", "b"]], "the line is read once it is whole");
});
