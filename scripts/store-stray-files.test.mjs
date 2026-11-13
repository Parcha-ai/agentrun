// A store's files live in the data directory (or at the file) it is opened with, never in the checkout: a store opened
// with no place once left its owner lock, "undefined.owner", in the working directory of whatever ran it. No file of a
// store (an owner lock, or a file named from "undefined") sits anywhere in the checkout outside node_modules.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git"]);
const stray = (name) => name.endsWith(".owner") || name === "undefined" || name.startsWith("undefined.");

/** Every stray store file under `root`, relative to it. */
function strayStoreFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(join(dir, entry.name));
      } else if (stray(entry.name)) found.push(relative(root, join(dir, entry.name)));
    }
  };
  walk(root);
  return found.sort();
}

test("the guard finds a store's owner lock and a file named from undefined, at any depth, and nothing in node_modules", (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "store-stray-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "packages", "serve"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(join(dir, "packages", "serve", "undefined.owner"), "");
  writeFileSync(join(dir, "undefined"), "");
  writeFileSync(join(dir, "node_modules", "x", "y.owner"), "");
  writeFileSync(join(dir, "owner.md"), "");
  assert.deepEqual(strayStoreFiles(dir), ["packages/serve/undefined.owner", "undefined"]);
});

test("no store file sits in the checkout", () => {
  assert.deepEqual(strayStoreFiles(ROOT), []);
});
