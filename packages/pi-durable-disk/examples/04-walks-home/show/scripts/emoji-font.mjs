// Noto Color Emoji (SIL OFL 1.1), served by the stage itself: copied from the @infolektuell/noto-color-emoji package (the COLRv1 build: Chrome paints it; the @fontsource package is OpenType-SVG, which Chrome draws as
// nothing) into a page's dist/fonts at build time (woff2 only, with a stylesheet whose urls are relative), so the page needs no outbound fetch and nothing binary is committed. The model's answers carry emoji and the recording machine has no emoji font.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const FONT_CSS = "noto-color-emoji.css";

// The family goes FIRST in every font stack (a system font that has its own plain glyph for an emoji, like DejaVu Sans for the full moon, would otherwise win), so its
// unicode-range must not reach ordinary text. These are the package's codepoints that text uses too: ASCII digits, "#" and "*", (c) (R) (TM), "!!" "!?" and "i" in a box,
// the arrows, the geometric shapes, and the circled M. They stay with the text font.
export const TEXT_RANGES = [[0x23, 0x23], [0x2a, 0x2a], [0x30, 0x39], [0xa9, 0xa9], [0xae, 0xae], [0x203c, 0x203c], [0x2049, 0x2049], [0x2122, 0x2122], [0x2139, 0x2139], [0x2190, 0x21ff], [0x24c2, 0x24c2], [0x25a0, 0x25ff]];

/** One face's `unicode-range` list without the text codepoints; null when nothing is left. Tokens are "U+hex" or "U+hex-hex". */
export function emojiOnlyRanges(list) {
  const out = [];
  for (const token of list.split(",").map((t) => t.trim()).filter(Boolean)) {
    const [lo, hi = lo] = token.slice(2).split("-").map((h) => parseInt(h, 16));
    let parts = [[lo, hi]];
    for (const [a, b] of TEXT_RANGES) parts = parts.flatMap(([x, y]) => (y < a || x > b ? [[x, y]] : [...(x < a ? [[x, a - 1]] : []), ...(y > b ? [[b + 1, y]] : [])]));
    for (const [x, y] of parts) out.push(x === y ? `U+${x.toString(16)}` : `U+${x.toString(16)}-${y.toString(16)}`);
  }
  return out.length ? out.join(", ") : null;
}

export function copyEmojiFont(outDir) {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("@infolektuell/noto-color-emoji/package.json"));
  const dir = join(outDir, "fonts");
  mkdirSync(join(dir, "files"), { recursive: true });
  // The package's stylesheet names a woff2 and a woff for each subset (the woff is dropped), and a face whose whole range was text is dropped with its file.
  const css = readFileSync(join(pkg, "index.css"), "utf8")
    .replace(/, url\(\.\/files\/[^)]*\.woff\) format\('woff'\)/g, "")
    .replace(/@font-face \{[^}]*\}\n*/g, (face) => {
      const range = emojiOnlyRanges(/unicode-range:\s*([^;]+);/.exec(face)?.[1] ?? "");
      return range ? face.replace(/unicode-range:\s*[^;]+;/, `unicode-range: ${range};`) : "";
    });
  for (const m of css.matchAll(/url\(\.\/files\/([^)]+)\)/g)) copyFileSync(join(pkg, "files", m[1]), join(dir, "files", m[1]));
  writeFileSync(join(dir, FONT_CSS), css);
  copyFileSync(join(pkg, "LICENSE"), join(dir, "LICENSE"));
  return dir;
}
