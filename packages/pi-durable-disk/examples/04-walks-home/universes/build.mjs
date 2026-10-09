// Bundles the universe app and the machine probe for the boxes: ES modules with the demo agent's modules inlined and
// every package left to the box's node_modules (the runtime snapshot's, next to which they are installed).
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: { "universe-app": join(here, "universe-app.ts"), probe: join(here, "probe.ts") },
  outdir: join(here, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  legalComments: "none",
  logLevel: "warning",
});
