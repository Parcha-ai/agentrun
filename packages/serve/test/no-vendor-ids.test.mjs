// Serve knows no computer vendor: what a provider takes (its keys and the options they fill, its settings, a ledger, a
// local host, prepareImage) comes from its descriptor, never from its id. Every provider id literal in serve/src is
// held to scripts/check-vendor-ids.mjs's BASELINE: the old stacks CP-4 and DEL-03 remove, and named false positives,
// counted per file and id. A file that gains one fails, naming its lines; one that loses some asks for its baseline to
// be lowered.
import assert from "node:assert/strict";
import test from "node:test";
import { DESCRIPTORS } from "@parcha/agentrun-computer";
import { BASELINE, baselineProblems, scan, SRC, vendorIdLiterals } from "../scripts/check-vendor-ids.mjs";

const IDS = DESCRIPTORS.map((descriptor) => descriptor.id);

test("no provider id is named in serve/src beyond the baseline of the old stacks being removed", async () => {
	assert.ok(IDS.length >= 8, `the computer package's built-in providers: ${IDS.join(", ")}`);
	assert.deepEqual(baselineProblems(await vendorIdLiterals(SRC, IDS)), []);
});

test("the baseline names a reason for every file, and no file the computer path owns", () => {
	for (const [file, { why, ids }] of Object.entries(BASELINE)) {
		assert.ok(typeof why === "string" && why.length > 10, file);
		assert.ok(Object.values(ids).every((count) => Number.isInteger(count) && count > 0), file);
	}
	for (const file of ["computer-keys.ts", "computers.ts", "workspace/computer-deps.ts", "workspace/computer-for-claim.ts", "workspace/computer-ledger.ts", "workspace/computer-providers.ts", "workspace/resolve-computer.ts"]) {
		assert.ok(!Object.hasOwn(BASELINE, file), `${file} is the computer path: it may name no vendor`);
	}
});

test("the scan reads source, not text: a string or an object key that is an id counts; a comment, a longer string, a docker command and an identifier do not", () => {
	const source = [
		'// docker and modal in a comment',
		'const a = "docker";',
		'const b = { modal: 1, "phone-harness": 2 };',
		'const c = "docker run";',
		'execFile("docker", ["info"]);',
		'child.spawn("docker", []);',
		'const kernel = 1;',
		"if (x === `e2b`) {}",
		'switch (y) { case "orgo": break; }',
	].join("\n");
	assert.deepEqual(
		scan(source, "fixture.ts", IDS).map(({ line, id }) => `${line}:${id}`),
		["2:docker", "3:modal", "3:phone-harness", "8:e2b", "9:orgo"],
	);
});

test("baselineProblems: more than the baseline fails naming the lines; fewer asks for the baseline to be lowered; a file not in it may name none", () => {
	const baseline = { "old.ts": { ids: { docker: 2 }, why: "DEL-03: a fixture" } };
	const at = (file, line, id) => ({ file, line, id });
	assert.deepEqual(baselineProblems([at("old.ts", 1, "docker"), at("old.ts", 2, "docker")], baseline), []);
	const [more] = baselineProblems([at("old.ts", 1, "docker"), at("old.ts", 2, "docker"), at("old.ts", 9, "docker")], baseline);
	assert.match(more, /^old\.ts names the provider "docker" 3 times \(lines 1, 2, 9\), above its baseline of 2/);
	const [fewer] = baselineProblems([at("old.ts", 1, "docker")], baseline);
	assert.match(fewer, /^old\.ts names "docker" 1 time, below its baseline of 2 \(DEL-03: a fixture\): lower BASELINE/);
	const [none] = baselineProblems([at("old.ts", 1, "docker"), at("old.ts", 2, "docker"), at("new.ts", 4, "kernel")], baseline);
	assert.match(none, /^new\.ts names the provider "kernel" 1 time \(lines 4\), and may name none/);
});
