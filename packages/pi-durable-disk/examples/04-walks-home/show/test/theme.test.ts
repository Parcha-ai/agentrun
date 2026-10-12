import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error plain .mjs shared by the pages' builds
import { copyTheme } from "../../../theme/copy-theme.mjs";

// The demo's look is one stylesheet and its fonts, written into each page's build: no network, no emoji, the sites' tokens.
const css = readFileSync(new URL("../../../theme/theme.css", import.meta.url), "utf8");

test("the stylesheet carries the agentrun.ai tokens and the components the pages use", () => {
  for (const [token, value] of [["--bg", "#080809"], ["--panel", "#111113"], ["--line", "#2c2c30"], ["--ink", "#f2f2f2"], ["--muted", "#a4a4ad"], ["--accent", "#ff8700"]] as const) assert.match(css, new RegExp(`${token}:\\s*${value}`, "i"), token);
  for (const cls of [".eyebrow", ".num", ".dot", ".card", ".chat", ".turn.user", ".turn.agent", ".tool", ".composer", ".btn.primary"]) assert.ok(css.includes(cls), cls);
  assert.match(css, /font:\s*400 16px\/1\.3 var\(--sans\)/, "the composer's type is 16 px: a phone zooms anything smaller");
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /min-height:\s*44px/);
  assert.doesNotMatch(css, /#(?:ff0000|e53935|b3261e|ff6b5e)\b/i, "no red alarms");
  assert.doesNotMatch(css, /prefers-color-scheme:\s*light/, "dark only, as the sites");
});

test("copyTheme writes the stylesheet, the font css and every font file it names, with the licence, and nothing points at the network", () => {
  const out = mkdtempSync(join(tmpdir(), "theme-"));
  const dir = copyTheme(out, createRequire(import.meta.url));
  assert.ok(existsSync(join(dir, "theme.css")));
  const fonts = readFileSync(join(dir, "fonts.css"), "utf8");
  const files = [...fonts.matchAll(/url\(\.\/fonts\/([^)]+)\)/g)].map((m) => m[1]!);
  assert.equal(files.length, 6);
  for (const f of files) assert.ok(existsSync(join(dir, "fonts", f)), f);
  assert.ok(existsSync(join(dir, "fonts", "LICENSE-inter.txt")), "the Inter licence ships");
  assert.ok(existsSync(join(dir, "fonts", "LICENSE-jetbrains-mono.txt")), "the JetBrains Mono licence ships");
  assert.doesNotMatch(fonts + css, /https?:\/\//, "no network");
  assert.match(fonts, /font-family: "Inter"/);
  assert.match(fonts, /font-family: "JetBrains Mono"/);
});

test("the component sheet keeps its composer on screen: the grid has the viewport's height, so the middle scrolls", () => {
  const html = readFileSync(new URL("../../../theme/preview.html", import.meta.url), "utf8");
  assert.match(html, /body \{[^}]*\bheight: 100dvh;/);
  assert.doesNotMatch(html, /body \{[^}]*min-height: 100dvh/);
});
