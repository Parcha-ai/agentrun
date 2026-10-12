// Bundle episode 2's page: episode2/page/main.ts -> episode2/page/dist/main.js (browser ESM), and copy index.html beside it.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyTheme } from "../../../../theme/copy-theme.mjs";
import { copyEmojiFont } from "../../scripts/emoji-font.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(out, { recursive: true });
const result = await build({
  entryPoints: [join(here, "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});
copyFileSync(join(here, "index.html"), join(out, "index.html"));
copyFileSync(join(here, "..", "..", "page", "stage-theme.css"), join(out, "stage-theme.css"));
copyTheme(out, createRequire(import.meta.url));
copyFileSync(join(here, "..", "..", "page", "robot-pieces.css"), join(out, "robot-pieces.css"));
copyEmojiFont(out);
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`obsession main.js: ${bytes} bytes`);
