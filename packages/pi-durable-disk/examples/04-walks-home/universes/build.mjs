// Bundles what the boxes run: the universe app (direct transport), the machine probe, and the pipe transport's runner.
// The direct app inlines the demo agent's modules and leaves the package and pi to the box's node_modules (the runtime
// snapshot's, next to which it is installed). The probe and the runner are self-contained; the runner inlines `ws`, a
// CommonJS module, so its bundle gets a `require` of its own.
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
// The pipe's runner is self-contained (pi included): a box needs only Node and the run user, as a GPU image has them.
await build({
  ...common,
  external: ["bufferutil", "utf-8-validate"],
  entryPoints: { "universe-remote": join(here, "universe-remote.ts") },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
