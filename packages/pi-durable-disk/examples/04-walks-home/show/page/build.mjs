// Bundle the page: page/main.ts -> page/dist/main.js (browser ESM), and copy the static files beside it.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
copyFileSync(join(here, "storyboard.html"), join(out, "storyboard.html"));
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`main.js: ${bytes} bytes`);
