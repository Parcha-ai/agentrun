// The free bench: every `*.bench.mjs` in this directory, in name order, each in its own process. It measures time,
// bytes, pixels and memory on synthetic files only, and needs no network and no model.
//   npm run bench -w @parcha/pi-vision
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(DIR).filter((name) => name.endsWith(".bench.mjs")).sort();
if (!files.length) { console.log("no bench files yet"); process.exit(0); }
for (const file of files) {
  const run = spawnSync(process.execPath, [join(DIR, file), ...process.argv.slice(2)], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
