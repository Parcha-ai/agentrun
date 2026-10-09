// Bundles the universe app for the boxes: one ES module with the demo agent's modules inlined and every package left to
// the box's node_modules (the runtime snapshot's, next to which it is installed).
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "universe-app.ts")],
  outfile: join(here, "dist/universe-app.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  legalComments: "none",
  logLevel: "warning",
});
