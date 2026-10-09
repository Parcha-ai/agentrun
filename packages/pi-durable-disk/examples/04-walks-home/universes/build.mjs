// Bundles what the boxes run: the universe app (direct transport), the machine probe, and the pipe transport's runner.
// The demo agent's modules are inlined; the package and pi stay external, resolved from the box's node_modules (the
// runtime snapshot's, next to which the bundles are installed). The runner also inlines `ws`, a CommonJS module, so
// its bundle gets a `require` of its own.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: join(here, "dist"),
  outExtension: { ".js": ".mjs" },
  external: ["@parcha/*", "@earendil-works/*", "bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "warning",
};
await build({ ...common, entryPoints: { "universe-app": join(here, "universe-app.ts"), probe: join(here, "probe.ts") } });
await build({
  ...common,
  entryPoints: { "universe-remote": join(here, "universe-remote.ts") },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
