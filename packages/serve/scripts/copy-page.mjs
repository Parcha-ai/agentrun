// The page's own files (src/page) and the vendored OpenAPI contract (src/openapi) are plain files; tsc leaves them out,
// so the build copies them next to the server.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
cpSync(join(root, "src", "page"), join(root, "dist", "page"), { recursive: true });
cpSync(join(root, "src", "openapi"), join(root, "dist", "openapi"), { recursive: true });
