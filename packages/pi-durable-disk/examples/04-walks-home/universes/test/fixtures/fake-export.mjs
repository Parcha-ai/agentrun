// A stand-in for ../train/export.py's `combine WALK GETUP --out OUT` (run with node in place of python): one file
// holding both policies, as the tab loads it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [verb, walk, getup, flag, out] = process.argv.slice(2);
if (verb !== "combine" || flag !== "--out") process.exit(2);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ walk: JSON.parse(readFileSync(walk, "utf8")), getup: JSON.parse(readFileSync(getup, "utf8")) }));
