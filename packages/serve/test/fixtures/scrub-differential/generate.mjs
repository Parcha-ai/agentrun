// Writes expected.json: for each corpus row (corpus.mjs), in each wrap, the characters main's scrubber cut, read in
// count mode. Main is the scrubber before the shell lexer: BASE (corpus.mjs). To regenerate, in a checkout of BASE with
// a clean tree, build packages/serve (tsc), then
//   node <this file> <that checkout's root>
// It reads that checkout's packages/serve/dist, and refuses when the checkout is not BASE, its tree is not clean, the
// build is older than a source it compiles, or the build reads commands with the shell lexer (no build of BASE does).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE, corpus, covered, WRAPS } from "./corpus.mjs";

const refuse = (why) => {
  console.error(`generate.mjs: ${why}\nusage: generate.mjs <root of a clean checkout of ${BASE}, packages/serve built>`);
  process.exit(2);
};
const root = process.argv[2] ? resolve(process.argv[2]) : refuse("no checkout given");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (git("rev-parse", "HEAD") !== BASE) refuse(`${root} is at ${git("rev-parse", "HEAD")}, not ${BASE}`);
if (git("status", "--porcelain", "--untracked-files=no") !== "") refuse(`${root} has changes to tracked files`);
const src = join(root, "packages/serve/src");
const dist = join(root, "packages/serve/dist");
for (const file of readdirSync(src).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
  const built = join(dist, file.replace(/\.ts$/, ".js"));
  if (!existsSync(built) || statSync(built).mtimeMs < statSync(join(src, file)).mtimeMs) refuse(`${built} is missing or older than its source: build packages/serve`);
}
if (existsSync(join(dist, "shell-lex.js")) || readFileSync(join(dist, "secret-rules.js"), "utf8").includes("shell-lex")) refuse(`${dist} reads commands with the shell lexer: it is no build of ${BASE}`);

const { scrub } = await import(join(dist, "secret-cut.js"));
const rows = {};
for (const row of corpus()) {
  rows[row.id] = {};
  for (const [wrap, write] of Object.entries(WRAPS)) {
    const out = await scrub(write(row.text), { mode: "count" });
    rows[row.id][wrap] = covered(out.cuts);
  }
}
writeFileSync(new URL("./expected.json", import.meta.url), `${JSON.stringify({ base: BASE, generator: "test/fixtures/scrub-differential/generate.mjs", rows }, null, 1)}\n`);
console.log(`expected.json: ${Object.keys(rows).length} rows from ${BASE}`);
