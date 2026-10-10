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

// WOFF2 table directory (https://www.w3.org/TR/WOFF2/#table_dir_format): the tags of the tables a font file carries, without decompressing it.
const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];
function woff2Tables(buf: Buffer): string[] {
  assert.equal(buf.toString("latin1", 0, 4), "wOF2");
  const n = buf.readUInt16BE(12);
  let at = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[at++]!; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error("bad UIntBase128"); };
  const tags: string[] = [];
  for (let i = 0; i < n; i++) {
    const flags = buf[at++]!;
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 63) { tag = buf.toString("latin1", at, at + 4); at += 4; } else tag = KNOWN[idx]!;
    base128(); // origLength
    const transform = flags >> 6;
    if (tag === "glyf" || tag === "loca" ? transform === 0 : transform !== 0) base128(); // transformLength
    tags.push(tag);
  }
  return tags;
}

// Chrome does not paint OpenType-SVG fonts (the @fontsource package's flavor): every emoji rendered blank, except where the font's plain outline fallback is a
// circle (the full moon showed as a stray "○"). A colour font Chrome paints carries COLR/CPAL (COLRv1) or CBDT/CBLC, and no SVG table.
test("every emoji font file carries a colour table Chrome can paint, and none is an OpenType-SVG font", () => {
  const out = mkdtempSync(join(tmpdir(), "emoji-font-"));
  try {
    const dir = copyEmojiFont(out) as string;
    const css = readFileSync(join(dir, "noto-color-emoji.css"), "utf8");
    const files = readdirSync(join(dir, "files"));
    assert.ok(files.length >= 10);
    for (const f of files) {
      const tags = woff2Tables(readFileSync(join(dir, "files", f)));
      assert.ok(tags.includes("COLR") && tags.includes("CPAL") || tags.includes("CBDT") && tags.includes("CBLC"), `${f}: ${tags.join(",")}`);
      assert.ok(!tags.includes("SVG "), `${f} is an OpenType-SVG font, which Chrome paints as nothing`);
    }
    assert.ok([...css.matchAll(/src: url[^;]*;/g)].every((m) => /tech\(color-COLRv1\)/.test(m[0]!)), "each face says it is a COLRv1 colour font, so a browser that cannot paint one skips it for the next font instead of drawing nothing");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
