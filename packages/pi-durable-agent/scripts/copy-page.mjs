// The page of `pi-durable-agent serve` is plain static files in src/serve; tsc leaves them out, so the build copies them next to the server.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "serve");
const to = join(root, "dist", "serve");
mkdirSync(to, { recursive: true });
for (const name of readdirSync(from).filter((file) => /^page\.(html|css|js)$/.test(file))) copyFileSync(join(from, name), join(to, name));
