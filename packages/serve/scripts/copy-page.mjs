// The console's build (apps/console/dist, made by `npm run build` there) and the vendored OpenAPI contract
// (src/openapi) are plain files; tsc leaves them out, so the build copies them next to the server. The console's
// Storybook (dist/storybook) is not the console and stays out. A build with no console built serves a plain page that
// says so (src/page.ts), and says it here too.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "..", "..", "apps", "console", "dist");
cpSync(join(root, "src", "openapi"), join(root, "dist", "openapi"), { recursive: true });
if (existsSync(join(built, "index.html"))) {
  cpSync(built, join(root, "dist", "console"), { recursive: true, filter: (source) => !source.startsWith(join(built, "storybook")) });
} else {
  console.warn("agentrun-serve: apps/console is not built (npm ci && npm run build in apps/console); this build serves no console");
}
