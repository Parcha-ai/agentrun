// The page's own files are plain static files in src/page; tsc leaves them out, so the build copies them next to the server.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "page"), join(root, "dist", "page"), { recursive: true });
