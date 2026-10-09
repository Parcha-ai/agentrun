// Bundle the page: tab/main.ts -> tab/dist/main.js (browser, ESM). The Wasmer SDK is not bundled: the server serves
// its package directory at /wasmer/ (its worker and wasm load relative to it), and the page imports it from there.
// The computer's package (`wasmer/edgejs`: bash, coreutils, node) is served at /pkgs/edgejs.webc; `node tab/build.mjs
// --fetch` downloads it once from Wasmer's CDN and checks its digest.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(join(out, "pkgs"), { recursive: true });

/** wasmer/edgejs 0.2.5 (bash, coreutils, node 24, npm), as the registry lists it. */
export const COMPUTER = {
  name: "wasmer/edgejs@0.2.5",
  url: "https://cdn.wasmer.io/webcimages/7f956b2311ed904daa2c404b85469aa86cdc4c86e772f57432820ef905ded351.webc",
  sha256: "7f956b2311ed904daa2c404b85469aa86cdc4c86e772f57432820ef905ded351",
};

const target = join(out, "pkgs", "edgejs.webc");
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
if (process.argv.includes("--fetch") && !(existsSync(target) && digest(target) === COMPUTER.sha256)) {
  const from = process.env.WEBC_FROM;
  if (from) copyFileSync(from, target);
  else writeFileSync(target, new Uint8Array(await (await fetch(COMPUTER.url)).arrayBuffer()));
  if (digest(target) !== COMPUTER.sha256) throw new Error(`${COMPUTER.name}: digest mismatch`);
  console.log(`${COMPUTER.name}: ${statSync(target).size} bytes`);
}

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
  external: ["/wasmer/*"],
  logLevel: "warning",
});
copyFileSync(join(here, "index.html"), join(out, "index.html"));
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`main.js: ${bytes} bytes`);
