// The `@parcha/pi-durable-disk/lease` entry: the names it promises, and that bundling it leaves out the supervisor, the host
// drivers, the CLI and the app contract (the reason the entry exists). The bundle check needs an esbuild binary:
// PDA_ESBUILD=<path>, or `esbuild` resolvable from this package; skipped otherwise.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as lease from "../src/lease.ts";
import { scratchRoot } from "./_run-support.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function esbuildBinary(): string | undefined {
  if (process.env.PDA_ESBUILD) return process.env.PDA_ESBUILD;
  try {
    const bin = join(createRequire(import.meta.url).resolve("esbuild/package.json"), "..", "bin", "esbuild");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}
const ESBUILD = esbuildBinary();

describe("the lease entry", () => {
  it("exports what a host that owns its Harness needs, and nothing of the supervisor, the drivers or the app contract", () => {
    const names = Object.keys(lease);
    for (const name of [
      "openRunLease", "storeHead", "OWNER_LOCK", "STORE_FILE", "EXIT_DATAERR", "EXIT_SOFTWARE", "RunError", "StoreBehindSealError", "LeaseLapsedError",
      "EXIT_FENCED", "EXIT_HELD", "PdaError", "FencedError", "HeldError", "ClaimError", "exitCodeFor", "ownWriteFenced",
      "Fence", "FencedDatabase", "assertPragmas", "PROFILE_PRAGMAS", "openArchilStore", "StoreFencedError", "StoreBusyError", "StorePragmaError",
    ]) assert.ok(names.includes(name), `${name} is exported`);
    for (const name of ["ensureRunning", "superviseRuns", "localHost", "loadApp", "openDurableRun", "acquire", "archilEnv", "ArchilCodingTools", "checkHost"]) {
      assert.ok(!names.includes(name), `${name} is not part of the lease entry`);
    }
  });

  it("bundles without supervise, the host drivers, the CLI or the app contract", { skip: ESBUILD ? false : "no esbuild: set PDA_ESBUILD to an esbuild binary", timeout: 60_000 }, () => {
    const dir = scratchRoot("lease-bundle");
    try {
      const meta = join(dir.root, "meta.json");
      const built = spawnSync(ESBUILD!, ["src/lease.ts", "--bundle", "--platform=node", "--format=esm", "--packages=external", `--metafile=${meta}`, `--outfile=${join(dir.root, "lease.mjs")}`], { cwd: ROOT, encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr);
      const inputs = Object.keys((JSON.parse(readFileSync(meta, "utf8")) as { inputs: Record<string, unknown> }).inputs).map((p) => relative(ROOT, join(ROOT, p)));
      for (const unwanted of ["src/supervise.ts", "src/hosts/local-host.ts", "src/cli.ts", "src/app.ts"]) assert.ok(!inputs.includes(unwanted), `${unwanted} is in the lease bundle`);
      for (const wanted of ["src/run.ts", "src/store.ts", "src/claim.ts"]) assert.ok(inputs.includes(wanted), `${wanted} is in the lease bundle`);
    } finally {
      dir.remove();
    }
  });
});
