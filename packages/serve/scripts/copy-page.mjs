// The vendored OpenAPI contract (src/openapi), llms.txt and the learning folder's script (src/learn/learning.sh) are plain
// files; tsc leaves them out, so the build copies them next to the server.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "openapi"), join(root, "dist", "openapi"), { recursive: true });
cpSync(join(root, "src", "llms.txt"), join(root, "dist", "llms.txt"));
cpSync(join(root, "src", "learn", "learning.sh"), join(root, "dist", "learn", "learning.sh"));
// The store's Postgres migrations (store/postgres/migrate.ts reads them beside itself).
cpSync(join(root, "src", "store", "postgres", "migrations"), join(root, "dist", "store", "postgres", "migrations"), { recursive: true });

// The console (apps/console), when its own build ran first: its index.html and Vite's assets, never a source map, into
// dist/console, which the server answers at /, with the notices of what it bundles. Without that build the server says
// so there.
const built = join(root, "..", "..", "apps", "console", "dist");
if (existsSync(join(built, "index.html"))) {
  const index = readFileSync(join(built, "index.html"), "utf8");
  // The server's CSP (src/page.ts) runs no inline script or style, and the console's paths stay relative to it.
  const problems = [
    [/<script\b(?![^>]*\ssrc\s*=)[^>]*>/i, "an inline <script>"],
    [/<style[\s>]/i, "a <style> block"],
    [/\sstyle\s*=/i, "a style attribute"],
    [/\s(?:src|href)\s*=\s*["']?\//i, "an absolute src or href (the console builds with base './')"],
  ].filter(([pattern]) => pattern.test(index)).map(([, what]) => what);
  if (problems.length) throw new Error(`apps/console/dist/index.html has ${problems.join(", ")}: the server's CSP or path would refuse it`);
  mkdirSync(join(root, "dist", "console"), { recursive: true });
  cpSync(join(built, "index.html"), join(root, "dist", "console", "index.html"));
  // The licenses of the third-party code the console bundles (apps/console/third-party-notices.mjs), which NOTICE points
  // to. A console build without them is refused: this package would ship that code without its notices.
  const notices = join(built, "THIRD-PARTY-NOTICES.txt");
  if (!existsSync(notices)) throw new Error("apps/console/dist has no THIRD-PARTY-NOTICES.txt: build apps/console again (its Vite build writes it)");
  cpSync(notices, join(root, "dist", "console", "THIRD-PARTY-NOTICES.txt"));
  if (existsSync(join(built, "assets"))) cpSync(join(built, "assets"), join(root, "dist", "console", "assets"), { recursive: true, filter: (from) => !from.endsWith(".map") });
}
