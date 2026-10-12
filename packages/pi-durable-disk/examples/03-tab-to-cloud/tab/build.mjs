// Bundle the page: tab/main.ts -> tab/dist/main.js (browser, ESM). The Wasmer SDK is not bundled: the server serves
// its package directory at /wasmer/ (its worker and wasm load relative to it), and the page imports it from there.
// The computer's package (`wasmer/edgejs`: bash, coreutils, node) is served at /pkgs/edgejs.webc; `node tab/build.mjs
// --fetch` downloads it once from Wasmer's CDN and checks its digest.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyTheme } from "../../theme/copy-theme.mjs";

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

// The trained model runs in this page once it comes home (brain.ts, with the 04 tab's ModelHost): wllama's wasm is served next to the page, as the 04 tab does.
mkdirSync(join(out, "vendor"), { recursive: true });
copyFileSync(join(here, "../../04-walks-home/tab/node_modules/@wllama/wllama/esm/wasm/wllama.wasm"), join(out, "vendor", "wllama.wasm"));
// Its Safari build (no JSPI or memory64: every iPhone browser), served from here: wllama would otherwise fetch it from a CDN, and a phone offline has none.
// The shim's build (04-walks-home/tab/wllama-shim: slot restore for the warm state, 8 MiB reads) when it has been built, else npm's (the page then prefills).
mkdirSync(join(out, "vendor", "wllama-compat"), { recursive: true });
const shim = join(here, "../../04-walks-home/tab/wllama-shim/dist");
const compatFrom = existsSync(join(shim, "wllama.wasm")) ? shim : join(here, "../node_modules/@wllama/wllama-compat/wasm");
for (const f of ["wllama.js", "wllama.wasm"]) copyFileSync(join(compatFrom, f), join(out, "vendor", "wllama-compat", f));

// The browser store (local-store.ts): SQLite-WASM runs in a worker of its own, its wasm next to it.
copyFileSync(join(here, "../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"), join(out, "vendor", "sqlite3.wasm"));
// SQLite-WASM starts its OPFS VFS's async proxy whenever the page is cross-origin isolated, whether or not that VFS is used (the store uses opfs-sahpool): the file must be there, or every
// start of the store waits for a 404 (online) or for the service worker's timeout (offline, with a tunnel that hangs).
copyFileSync(join(here, "../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js"), join(out, "vendor", "sqlite3-opfs-async-proxy.js"));
await build({ entryPoints: [join(here, "sqlite-worker.ts")], outfile: join(out, "vendor", "sqlite-worker.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, logLevel: "warning" });

// The service worker of a run checked out to this browser (offline.ts registers it at checkout; online, nothing loads it).
await build({ entryPoints: [join(here, "sw.ts")], outfile: join(out, "sw.js"), bundle: true, format: "iife", platform: "browser", target: "es2022", minify: true, logLevel: "warning" });

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
// The demo's look: the shared theme and its fonts (shipped, no network) under /theme/, and this page's own sheet beside the page.
copyTheme(out, createRequire(import.meta.url));
copyFileSync(join(here, "agent-theme.css"), join(out, "agent-theme.css"));
// What a checkout puts in the cache besides the run's page and its model: every built file the page loads (offline.ts reads this list). The computer's package is left out: it is not started offline.
const built = (dir, base = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "pkgs" ? [] : built(join(dir, e.name), `${base}/${e.name}`)) : [`${base}/${e.name}`]));
// The in-browser computer: the Wasmer SDK's files (the server serves the package at /wasmer/) and the computer's package, so the sandbox boots with no network.
const sdk = join(here, "..", "node_modules", "@wasmer", "sdk");
const sdkFiles = ["dist", "pkg"].flatMap((d) => (existsSync(join(sdk, d)) ? built(join(sdk, d), `/wasmer/${d}`) : []));
const computer = existsSync(join(out, "pkgs", "edgejs.webc")) ? ["/pkgs/edgejs.webc"] : [];
writeFileSync(join(out, "offline.json"), JSON.stringify({ files: [...built(out).filter((f) => !/\.map$/.test(f) && !["/offline.json", "/sw.js", "/index.html"].includes(f)), ...sdkFiles.filter((f) => !/\.(map|d\.ts|md)$|LICENSE$/.test(f)), ...computer].sort() }));
const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`main.js: ${bytes} bytes`);
