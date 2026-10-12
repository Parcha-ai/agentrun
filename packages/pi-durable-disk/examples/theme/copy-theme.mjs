// Writes the demo's theme into a page's build folder: theme/theme.css, theme/fonts.css and the font files (Inter 400/500/600 and JetBrains Mono 400/500/700, latin, woff2, OFL 1.1, from the
// @fontsource packages: nothing binary is committed, and the page needs no network, so the demo works offline). The page links `theme/theme.css` and `theme/fonts.css`; a page that is
// served from a path (the stage under /show/) links them relative, the tab page at /run/<id> links them from the root.
//   import { copyTheme } from "../../theme/copy-theme.mjs";  copyTheme(outDir, createRequire(import.meta.url));
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FONT_FACES = [
  ["Inter", "inter", "@fontsource/inter", [400, 500, 600]],
  ["JetBrains Mono", "jetbrains-mono", "@fontsource/jetbrains-mono", [400, 500, 700]],
];

/** `requireFrom`: a `require` made in the folder whose node_modules holds the font packages. Returns the folder written. */
export function copyTheme(outDir, requireFrom) {
  const dir = join(outDir, "theme");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  copyFileSync(join(here, "theme.css"), join(dir, "theme.css"));
  let css = "/* Inter and JetBrains Mono, latin, woff2, SIL OFL 1.1 (@fontsource); shipped with the page so the demo works with no network. */\n";
  for (const [family, slug, pkg, weights] of FONT_FACES) {
    const root = dirname(requireFrom.resolve(`${pkg}/package.json`));
    for (const w of weights) {
      const file = `${slug}-latin-${w}-normal.woff2`;
      copyFileSync(join(root, "files", file), join(dir, "fonts", file));
      css += `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${w}; font-display: swap; src: url(./fonts/${file}) format("woff2"); }\n`;
    }
    copyFileSync(join(root, "LICENSE"), join(dir, "fonts", `LICENSE-${slug}.txt`));
  }
  writeFileSync(join(dir, "fonts.css"), css);
  return dir;
}
