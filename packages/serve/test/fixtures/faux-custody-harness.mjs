// The faux harness's script for the custody tests (secret-custody.test.mjs): a claude-agent or codex run's one answer is
// what its process was handed, a short digest of each secret (never the value), as faux-custody.mjs reports a pi run's.
import { createHash } from "node:crypto";

const secrets = await import(new URL("../../dist/secrets.js", import.meta.url).href);
const digest = (value) => (value === undefined ? "none" : createHash("sha256").update(value).digest("hex").slice(0, 16));

export function script() {
  return [{ say: JSON.stringify({ handed: Object.fromEntries(secrets.SECRET_NAMES.map((name) => [name, digest(secrets.secret(name))])) }), usd: 0.001 }];
}
