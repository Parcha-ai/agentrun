import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs shared with the build script
import { stageFileList } from "../scripts/offline-list.mjs";

// The stage's file list for the agent's offline copy: /show/offline.json. The 03 server's service worker caches these files at checkout so a reload of the stage with the network off still
// loads it. Paths are relative to the stage's root (/show/). It lists what the page needs to start: the page, its script, its stylesheet and the fonts the stylesheet names.
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "obsession", "page", "dist");

test("every file the page's HTML and stylesheet name is in the list, and every listed file exists", { skip: !existsSync(join(dist, "index.html")) && "the page is not built (npm run build)" }, () => {
  const list = stageFileList(dist, "obsession/");
  assert.ok(list.files.includes("obsession/"), "the page itself, by its URL");
  assert.ok(list.files.includes("obsession/main.js"));
  assert.ok(list.files.includes("obsession/fonts/noto-color-emoji.css"));
  const html = readFileSync(join(dist, "index.html"), "utf8");
  for (const ref of [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]!)) {
    if (ref.startsWith("data:")) continue;
    if (/^https?:|^\/\//.test(ref)) assert.fail(`the page loads from another origin: ${ref}`);
    assert.ok(list.files.includes(`obsession/${ref}`), `${ref} is named by the page but not in the list`);
  }
  const css = readFileSync(join(dist, "fonts", "noto-color-emoji.css"), "utf8");
  for (const ref of [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]!)) assert.ok(list.files.includes(`obsession/fonts/${ref.replace(/^\.\//, "")}`), `${ref} is named by the stylesheet but not in the list`);
  for (const f of list.files) if (!f.endsWith("/")) assert.ok(existsSync(join(dist, f.replace(/^obsession\//, ""))), `${f} is listed but does not exist`);
  assert.equal(new Set(list.files).size, list.files.length, "no file twice");
  assert.match(list.version, /^[0-9a-f]{64}$/, "a version that changes when any listed file does");
});

test("the version changes when a listed file's bytes do, and not otherwise", { skip: !existsSync(join(dist, "index.html")) && "the page is not built (npm run build)" }, () => {
  const copy = mkdtempSync(join(tmpdir(), "stage-"));
  cpSync(dist, copy, { recursive: true });
  const a = stageFileList(copy, "obsession/");
  assert.equal(stageFileList(copy, "obsession/").version, a.version);
  writeFileSync(join(copy, "main.js"), `${readFileSync(join(copy, "main.js"), "utf8")}\n// changed`);
  assert.notEqual(stageFileList(copy, "obsession/").version, a.version);
  assert.deepEqual(stageFileList(copy, "obsession/").files, a.files);
});
