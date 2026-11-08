// isCommand, the one way a command in this package decides it is the one being run: where Node gives a module's meta
// main it is that; where it does not, the realpath of the script Node was given against the module's own, so a script
// run through a symlink is still the command and an imported module never is.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isCommand } from "../dist/entry.js";

test("isCommand: meta.main, where Node sets it, is the answer", () => {
	const url = pathToFileURL(join(tmpdir(), "elsewhere.js")).href;
	assert.equal(isCommand({ url, main: true }), true);
	assert.equal(isCommand({ url: import.meta.url, main: false }), false);
});

test("isCommand: without meta.main, a script run through a symlink is the command, and another module is not", () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-entry-"));
	try {
		const script = join(dir, "real.js");
		writeFileSync(script, "");
		const link = join(dir, "link.js");
		symlinkSync(script, link);
		assert.equal(isCommand({ url: pathToFileURL(script).href }, link), true, "run through a symlink");
		assert.equal(isCommand({ url: pathToFileURL(script).href }, script), true, "run by its own path");
		assert.equal(isCommand({ url: pathToFileURL(join(dir, "other.js")).href }, script), false, "an imported module");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
