// The page's own files (src/page), the vendored OpenAPI contract (src/openapi) and llms.txt are plain files; tsc leaves
// them out, so the build copies them next to the server.
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "page"), join(root, "dist", "page"), { recursive: true });
cpSync(join(root, "src", "openapi"), join(root, "dist", "openapi"), { recursive: true });
cpSync(join(root, "src", "llms.txt"), join(root, "dist", "llms.txt"));

// The console (apps/console), when its own build ran first: its index.html and Vite's assets, never a source map, into
// dist/console, which the server answers at /console/. Without that build the server says so there.
const built = join(root, "..", "..", "apps", "console", "dist");
if (existsSync(join(built, "index.html"))) {
  const index = readFileSync(join(built, "index.html"), "utf8");
  // The server's CSP (src/page.ts) runs no inline script or style, and the console is served below /console/.
  const problems = [
    [/<script\b(?![^>]*\ssrc\s*=)[^>]*>/i, "an inline <script>"],
    [/<style[\s>]/i, "a <style> block"],
    [/\sstyle\s*=/i, "a style attribute"],
    [/\s(?:src|href)\s*=\s*["']?\//i, "an absolute src or href (the console builds with base './')"],
  ].filter(([pattern]) => pattern.test(index)).map(([, what]) => what);
  if (problems.length) throw new Error(`apps/console/dist/index.html has ${problems.join(", ")}: the server's CSP or path would refuse it`);
  mkdirSync(join(root, "dist", "console"), { recursive: true });
  cpSync(join(built, "index.html"), join(root, "dist", "console", "index.html"));
  if (existsSync(join(built, "assets"))) cpSync(join(built, "assets"), join(root, "dist", "console", "assets"), { recursive: true, filter: (from) => !from.endsWith(".map") });
}
