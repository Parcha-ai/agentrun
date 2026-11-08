// The run's folder in a computer (src/mount.ts): the one workspace path, the spec rule every provider's check() shares,
// and the read-back. The Archil token is a secret: no refusal or read-back holds it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import * as computer from "../dist/index.js";

const TOKEN = "archil-token-0123456789abcdef";
const ARCHIL = { kind: "archil", disk: "dsk-runs", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work", token: TOKEN };
const root = realpathSync(mkdtempSync(join(tmpdir(), "computer-mount-")));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = join(root, "run");
mkdirSync(dir);

/** check's refusals for a mount, as fields and words. */
const refusals = (mount, declared) => computer.checkMount(mount, declared);

test("the workspace path in every computer is /workspace, and the mount kinds are bind and archil", () => {
	assert.equal(computer.WORKSPACE, "/workspace");
	assert.deepEqual([...computer.MOUNT_KINDS], ["bind", "archil"]);
});

test("checkMount: no mount is no refusal; a bind of an existing, canonical directory or an Archil folder is taken when declared", () => {
	assert.deepEqual(refusals(undefined, undefined), []);
	assert.deepEqual(refusals(undefined, []), []);
	assert.deepEqual(refusals({ kind: "bind", path: dir }, ["bind"]), []);
	assert.deepEqual(refusals(ARCHIL, ["archil"]), []);
	assert.deepEqual(refusals(ARCHIL, ["bind", "archil"]), []);
	assert.deepEqual(refusals({ ...ARCHIL, folder: "a/b/c" }, ["archil"]), []);
});

test("checkMount refuses a mount kind the provider does not declare, in words, with no token", () => {
	for (const [mount, declared, words] of [
		[{ kind: "bind", path: dir }, undefined, /declares no mount kind/],
		[{ kind: "bind", path: dir }, [], /declares no mount kind/],
		[{ kind: "bind", path: dir }, ["archil"], /does not take a mount of kind bind; it takes archil/],
		[ARCHIL, ["bind"], /does not take a mount of kind archil; it takes bind/],
		[ARCHIL, undefined, /declares no mount kind/],
	]) {
		const found = refusals(mount, declared);
		assert.equal(found.length, 1, JSON.stringify(found));
		assert.equal(found[0].field, "mount");
		assert.match(found[0].message, words);
		assert.ok(!JSON.stringify(found).includes(TOKEN), "the token is in a refusal");
	}
});

test("checkMount refuses what is not a mount, or a kind it does not know, in words", () => {
	for (const mount of [null, "bind", 1, [], { path: dir }, { kind: "nfs", path: dir }]) {
		const found = refusals(mount, ["bind", "archil"]);
		assert.deepEqual(found.map((r) => r.field), ["mount"], JSON.stringify(mount));
		assert.match(found[0].message, /mount is \{ kind: "bind", path \} or \{ kind: "archil", disk, region, folder, token \}/);
	}
});

test("checkMount's bind rule: an absolute path to an existing directory, canonical, with no NUL and no other field", () => {
	const file = join(root, "a-file");
	writeFileSync(file, "x");
	const link = join(root, "a-link");
	symlinkSync(dir, link);
	for (const [path, words] of [
		[undefined, /mount\.path is required: the run folder's absolute path on the host/],
		[7, /mount\.path is required/],
		["", /mount\.path is required/],
		["relative/run", /mount\.path must be absolute/],
		[`${dir}\0x`, /mount\.path: a NUL byte/],
		[join(root, "missing"), /mount\.path .*missing" is not a directory on the host/],
		[file, /mount\.path .*a-file" is not a directory on the host/],
		[link, new RegExp(`mount\\.path .*a-link" is not canonical: it resolves to "${dir}"`)],
		[`${dir}/`, /is not canonical/],
		[`${root}/./run`, /is not canonical/],
		[`${root}/run/../run`, /is not canonical/],
	]) {
		const found = refusals({ kind: "bind", path }, ["bind"]);
		assert.deepEqual(found.map((r) => r.field), ["mount"], `${JSON.stringify(path)}: ${JSON.stringify(found)}`);
		assert.match(found[0].message, words, JSON.stringify(path));
	}
	const extra = refusals({ kind: "bind", path: dir, readonly: true }, ["bind"]);
	assert.deepEqual(extra, [{ field: "mount", message: "mount.readonly is not a field of a bind mount" }]);
});

test("checkMount's Archil rule: disk, region, folder and token are non-empty strings, the folder relative inside the disk with no '..'; no word holds the token", () => {
	for (const [change, words] of [
		[{ disk: undefined }, /mount\.disk is required: the Archil disk's name/],
		[{ disk: "" }, /mount\.disk is required/],
		[{ disk: "a\0b" }, /mount\.disk: a NUL byte/],
		[{ region: undefined }, /^mount\.region is required: the Archil disk's region$/],
		[{ region: "" }, /^mount\.region is required/],
		[{ region: 7 }, /^mount\.region is required/],
		[{ region: "aws-us-east-1\0" }, /^mount\.region: a NUL byte/],
		[{ folder: undefined }, /mount\.folder is required: the run's folder inside the disk/],
		[{ folder: "" }, /mount\.folder is required/],
		[{ folder: "/runs/r1" }, /mount\.folder must be relative to the disk's root/],
		[{ folder: ".." }, /mount\.folder must stay inside the disk: no "\.\." part/],
		[{ folder: "runs/../../etc" }, /must stay inside the disk/],
		[{ folder: "runs/r1/.." }, /must stay inside the disk/],
		[{ folder: "runs\0r1" }, /mount\.folder: a NUL byte/],
		[{ token: undefined }, /mount\.token is required: the disk's token, a non-empty string/],
		[{ token: "" }, /mount\.token is required/],
		[{ token: 12345 }, /mount\.token is required/],
		[{ token: `${TOKEN}\0` }, /mount\.token: a NUL byte/],
		[{ secret: TOKEN }, /mount\.secret is not a field of an archil mount/],
	]) {
		const mount = { ...ARCHIL, ...change };
		const found = refusals(mount, ["archil"]);
		assert.deepEqual(found.map((r) => r.field), ["mount"], `${JSON.stringify(change)}: ${JSON.stringify(found)}`);
		assert.match(found[0].message, words, JSON.stringify(change));
		assert.ok(!JSON.stringify(found).includes(TOKEN), `the token is in the refusal of ${Object.keys(change)[0]}`);
	}
	// A token in the wrong field is still never echoed: a field's words name the field, not its value.
	for (const misplacedIn of [{ folder: `/${TOKEN}` }, { region: `${TOKEN}\0` }]) {
		const misplaced = refusals({ ...ARCHIL, ...misplacedIn }, ["archil"]);
		assert.equal(misplaced.length, 1, JSON.stringify(Object.keys(misplacedIn)));
		assert.ok(!misplaced[0].message.includes(TOKEN), misplaced[0].message);
	}
});

test("readBackOf: what a provider reads back of a mount is its kind and source, never the token", () => {
	assert.deepEqual(computer.readBackOf({ kind: "bind", path: dir }), { kind: "bind", path: dir });
	const read = computer.readBackOf(ARCHIL);
	assert.deepEqual(read, { kind: "archil", disk: "dsk-runs", region: "aws-us-east-1", folder: "agents/a1/runs/r1/work" });
	assert.ok(!JSON.stringify(read).includes(TOKEN));
});
