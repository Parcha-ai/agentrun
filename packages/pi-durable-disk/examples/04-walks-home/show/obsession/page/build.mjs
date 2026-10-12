// Bundle episode 2's page: episode2/page/main.ts -> episode2/page/dist/main.js (browser ESM), and copy index.html beside it.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
copyEmojiFont(out);
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`obsession main.js: ${bytes} bytes`);
