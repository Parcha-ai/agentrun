// The premise of the acknowledged advisory GHSA-fmh4-wcc4-5jm3 (scripts/better-auth-advisories.mjs): this server never
// loads better-auth's organization plugin, nor the plugins barrel that carries it. Checked in its source and its build.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const here = new URL("..", import.meta.url).pathname;
const BANNED = /["'`]better-auth\/plugins(?:\/organization[^"'`]*)?["'`]/;

/** Every file under `dir` with one of `extensions`. */
const files = (dir, extensions) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name));

/** The files whose text names a banned specifier. */
const offenders = (paths, read = (path) => readFileSync(path, "utf8")) => paths.filter((path) => BANNED.test(read(path)));

test("no serve source or built file imports better-auth's organization plugin or its plugins barrel", () => {
  const planted = { "a.ts": 'import { organization } from "better-auth/plugins/organization";', "b.js": "await import('better-auth/plugins')", "c.ts": 'import { admin } from "better-auth/plugins/admin";' };
  assert.deepEqual(offenders(Object.keys(planted), (path) => planted[path]), ["a.ts", "b.js"], "the check sees a planted import, and the admin plugin passes");
  const shipped = [...files(join(here, "src"), [".ts"]), ...files(join(here, "dist"), [".js", ".d.ts"])];
  assert.ok(shipped.length > 10, "it read the source and the build");
  assert.deepEqual(offenders(shipped), []);
});
