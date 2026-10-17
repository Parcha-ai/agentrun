import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the README quickstart runs with no key and prints what the README says", async () => {
  const readme = await readFile(path.join(PACKAGE, "README.md"), "utf8");
  const section = readme.split(/^## /m).find((part) => part.startsWith("Quickstart"));
  assert.ok(section, "the README has a Quickstart section");
  const [, code, expected] = /```js\n([\s\S]*?)```\n\n```\n([\s\S]*?)```/.exec(section) ?? [];
  assert.ok(code && expected, "a js block, then its output");
  const dir = await scratch();
  await writeFile(path.join(dir, "quickstart.mjs"), code);
  await symlink(path.join(PACKAGE, "..", "..", "node_modules"), path.join(dir, "node_modules"));
  const { status, out, err } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["quickstart.mjs"], { cwd: dir, env: { ...process.env, TMPDIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out, err }));
  });
  assert.equal(status, 0, err.slice(-2000));
  assert.equal(out.replace(/your repo at [0-9a-f]{12}\)/, "your repo at <sha>)"), expected);
});
