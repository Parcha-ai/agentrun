// The fake docker itself: its processes share their state files, so a call that reads one while another call writes it
// must read a whole file, the one before or the one after, never half of it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { fakeDocker } from "./fake-docker.mjs";

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
