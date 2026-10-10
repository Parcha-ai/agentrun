import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error plain .mjs build helper
import { copyEmojiFont } from "../scripts/emoji-font.mjs";

// The stage pages must not depend on an outbound font host: the font is built from the npm package into the page's own dist and served by the stage.
test("the emoji font is copied from the package: woff2 only, a stylesheet with relative urls only, its license beside it", () => {
  const out = mkdtempSync(join(tmpdir(), "emoji-font-"));
  try {
    const dir = copyEmojiFont(out) as string;
    const css = readFileSync(join(dir, "noto-color-emoji.css"), "utf8");
    assert.doesNotMatch(css, /https?:|\/\//, "no outbound url");
    assert.doesNotMatch(css, /\.woff\)/, "the older format is left out");
    const urls = [...css.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(urls.length >= 10 && urls.every((u) => u.endsWith(".woff2")), `${urls.length} subsets`);
    for (const u of urls) assert.ok(existsSync(join(dir, "files", u)), u);
    assert.equal(readdirSync(join(dir, "files")).length, urls.length, "only what the stylesheet names is copied");
    assert.match(css, /font-family: 'Noto Color Emoji'/);
    assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /SIL OPEN FONT LICENSE/i);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("neither stage page links a font from another host", () => {
  for (const page of ["../episode2/page/index.html", "../obsession/page/index.html"]) {
    const html = readFileSync(new URL(page, import.meta.url), "utf8");
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|https?:\/\/[^"']*\.(css|woff2?)/, page);
    assert.match(html, /<link rel="stylesheet" href="fonts\/noto-color-emoji\.css">/, page);
    assert.match(html, /"Noto Color Emoji"/, `${page}: in the font stacks`);
  }
});
