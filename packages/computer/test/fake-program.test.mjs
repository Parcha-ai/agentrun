// The fake program the Docker tests exec (fake-program.mjs): a call through it answers wherever the test's temp dir is,
// however long its path, and a fake that cannot listen fails the test at once, in words, never after it ended.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import * as program from "./fake-program.mjs";

const { fakeProgram } = program;
/** Where the fake program listens for path's calls (before its fix, path + ".sock"). */
const socketOf = program.socketOf ?? ((path) => `${path}.sock`);

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory whose path is far past a unix socket path's 108 bytes, as an agent's TMPDIR can be. */
function longDir() {
	const base = mkdtempSync(join(tmpdir(), "computer-fake-program-"));
	dirs.push(base);
	const deep = join(base, "a-temp-dir-as-long-as-an-agent-shell-gives-it".repeat(3));
	mkdirSync(deep, { recursive: true });
	return deep;
}

const run = (path, args) =>
	new Promise((resolve) => execFile(path, args, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

test("a call through a fake program under a temp dir past a socket path's length answers: its argv, stdout, stderr and exit code", { timeout: 20_000 }, async () => {
	const path = join(longDir(), "docker");
	assert.ok(`${path}.sock`.length > 108, "the program's own path is past what a unix socket path may be");
	fakeProgram(path, `process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("to stderr"); process.exitCode = 3;`);
	assert.deepEqual(await run(path, ["ps", "--filter", "label=a"]), { code: 3, stdout: '["ps","--filter","label=a"]', stderr: "to stderr" });
});

test("a fake program that cannot listen throws when it is made, in words: no test passes with a fake that never answers", () => {
	const path = join(longDir(), "docker");
	// Another listener holds the fake's socket first.
	const holder = createServer().listen(socketOf(path));
	try {
		assert.throws(() => fakeProgram(path, "process.exit(0);"), /the fake program .* cannot listen/);
	} finally {
		holder.close();
	}
});
