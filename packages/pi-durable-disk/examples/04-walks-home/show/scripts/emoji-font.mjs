// Noto Color Emoji (SIL OFL 1.1), served by the stage itself: copied from the @infolektuell/noto-color-emoji package (the COLRv1 build: Chrome paints it; the @fontsource package is OpenType-SVG, which Chrome draws as
// nothing) into a page's dist/fonts at build time (woff2 only, with a stylesheet whose urls are relative), so the page needs no outbound fetch and nothing binary is committed. The model's answers carry emoji and the recording machine has no emoji font.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const FONT_CSS = "noto-color-emoji.css";

export function copyEmojiFont(outDir) {
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve("@infolektuell/noto-color-emoji/package.json"));
  const dir = join(outDir, "fonts");
  mkdirSync(join(dir, "files"), { recursive: true });
  // The package's stylesheet names a woff2 and a woff for each subset; keep the woff2 only, and copy exactly the files it names.
  const css = readFileSync(join(pkg, "index.css"), "utf8").replace(/, url\(\.\/files\/[^)]*\.woff\) format\('woff'\)/g, "");
  for (const m of css.matchAll(/url\(\.\/files\/([^)]+)\)/g)) copyFileSync(join(pkg, "files", m[1]), join(dir, "files", m[1]));
  writeFileSync(join(dir, FONT_CSS), css);
  copyFileSync(join(pkg, "LICENSE"), join(dir, "LICENSE"));
  return dir;
}
