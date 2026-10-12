import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs shared with the build script
import { stageFileList } from "../scripts/offline-list.mjs";

// The stage's file list for the agent's offline copy: /show/offline.json, `{files: ["/show/", "/show/index.html", ...]}` (the 03 server's service worker caches these at checkout, so a reload of
// the stage with the network off still loads it). Entries are URL paths under /show/, no query, no "." or ".." segments. It lists what the page needs to start: the page, its script, its
// stylesheet and the fonts the stylesheet names.
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "obsession", "page", "dist");
const built = existsSync(join(dist, "index.html"));
const skip = !built && "the page is not built (npm run build)";

test("every file the page's HTML and stylesheet name is in the list, every listed file exists, and every entry is a clean /show/ path", { skip }, () => {
  const list = stageFileList(dist, "/show/");
  assert.ok(list.files.includes("/show/"), "the page itself, by its URL");
  assert.ok(list.files.includes("/show/index.html"));
  assert.ok(list.files.includes("/show/main.js"));
  assert.ok(list.files.includes("/show/fonts/noto-color-emoji.css"));
  const html = readFileSync(join(dist, "index.html"), "utf8");
  for (const ref of [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((m) => m[1]!)) {
    if (ref.startsWith("data:")) continue;
    if (/^https?:|^\/\//.test(ref)) assert.fail(`the page loads from another origin: ${ref}`);
    assert.ok(list.files.includes(`/show/${ref}`), `${ref} is named by the page but not in the list`);
  }
  const css = readFileSync(join(dist, "fonts", "noto-color-emoji.css"), "utf8");
  for (const ref of [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]!)) assert.ok(list.files.includes(`/show/fonts/${ref.replace(/^\.\//, "")}`), `${ref} is named by the stylesheet but not in the list`);
  for (const f of list.files) {
    assert.ok(f.startsWith("/show/"), f);
    assert.ok(!/[?#\\]/.test(f) && !f.split("/").some((seg: string) => seg === "." || seg === ".."), `${f} is not a clean path`);
    if (!f.endsWith("/")) assert.ok(existsSync(join(dist, f.slice("/show/".length))), `${f} is listed but does not exist`);
  }
  assert.equal(new Set(list.files).size, list.files.length, "no file twice");
  assert.match(list.version, /^[0-9a-f]{64}$/, "a version that changes when any listed file does");
});

test("the version changes when a listed file's bytes do, and not otherwise", { skip }, () => {
  const copy = mkdtempSync(join(tmpdir(), "stage-"));
  cpSync(dist, copy, { recursive: true });
  const a = stageFileList(copy, "/show/");
  assert.equal(stageFileList(copy, "/show/").version, a.version);
  writeFileSync(join(copy, "main.js"), `${readFileSync(join(copy, "main.js"), "utf8")}\n// changed`);
  assert.notEqual(stageFileList(copy, "/show/").version, a.version);
  assert.deepEqual(stageFileList(copy, "/show/").files, a.files);
});
