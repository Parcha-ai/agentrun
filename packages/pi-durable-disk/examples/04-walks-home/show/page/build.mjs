// Bundle the page: page/main.ts -> page/dist/main.js (browser ESM), and copy the static files beside it.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyTheme } from "../../../theme/copy-theme.mjs";

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
copyFileSync(join(here, "stage-theme.css"), join(out, "stage-theme.css"));
copyTheme(out, createRequire(import.meta.url));
copyFileSync(join(here, "robot-pieces.css"), join(out, "robot-pieces.css"));
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`main.js: ${bytes} bytes`);
