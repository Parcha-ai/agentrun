// Declaration files keep the `.ts` import specifiers of the sources (which run as TypeScript, so they must say `.ts`);
// the package ships `.js`, so a consumer's resolver has to see `.js`. Usage: node scripts/rewrite-dts.mjs [dir=dist]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
for (const file of walk(process.argv[2] ?? "dist").filter((f) => f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8");
  const out = text
    .replace(/(\bfrom\s+["'])(\.{1,2}\/[^"']*)\.ts(["'])/g, "$1$2.js$3")
    .replace(/(\bimport\(["'])(\.{1,2}\/[^"']*)\.ts(["']\))/g, "$1$2.js$3");
  if (out !== text) writeFileSync(file, out);
}
