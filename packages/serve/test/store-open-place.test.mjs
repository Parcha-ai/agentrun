// A store is opened in a data directory or at a file, never at neither: there is no in-memory store. Asked with neither
// (an options object whose dataDir and file are both missing or undefined), it is refused in words before anything is
// opened or made: no owner lock named "undefined.owner", no database file named "undefined", in the working directory
// or anywhere else.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");

for (const [what, options] of [
  ["no place, as the server", { role: "server" }],
  ["no place, as a runner", { role: "runner" }],
  ["both named undefined", { dataDir: undefined, file: undefined, role: "server" }],
]) {
  test(`a store opened with ${what} is refused in words, and nothing is made`, async (t) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-store-place-"));
    const home = process.cwd();
    process.chdir(dir);
    t.after(() => {
      process.chdir(home);
      rmSync(dir, { recursive: true, force: true });
    });
    const opened = await openSqliteStore(options).then((store) => store, (error) => ({ error }));
    t.after(() => opened.close?.());
    assert.deepEqual(readdirSync(dir), [], "nothing made in the working directory");
    assert.ok(opened.error instanceof TypeError && opened.error.message === "A store is opened in its data directory (dataDir) or at its file (file): neither was given, so nothing was opened or made.", `refused in words: ${opened.error ?? "it opened"}`);
  });
}
