import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as root from "../dist/index.js";

test("./export is the export lists alone: the built module imports nothing, and it is the module the root re-exports", async () => {
  const source = readFileSync(new URL("../dist/export.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import[\s{*"']|^\s*export\s[^;]*\bfrom\s*["']|\bimport\s*\(|\brequire\s*\(/m, "dist/export.js loads no module");
  const subpath = await import("@parcha/pi-durable-agent/export");
  assert.deepEqual(Object.keys(subpath).sort(), ["EXPORTABLE_KINDS", "SECRET_KINDS", "projectForExport"]);
  for (const name of ["EXPORTABLE_KINDS", "SECRET_KINDS", "projectForExport"]) assert.equal(subpath[name], root[name], name);
});
