// The Daytona live helper's box preparation installs this package from its working tree. That tree's lockfile is the
// workspace's, at the repository root, so the directory the box gets has none: its install must not need one. Offline,
// no key, no box.
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_INSTALL, packageTarball } from "./live/_p9.ts";

it("the box's package install works in the directory the box gets, which has no lockfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "pda-live-prepare-"));
  try {
    writeFileSync(join(dir, "pkg.tar.gz"), packageTarball());
    const listed = spawnSync("tar", ["-tzf", join(dir, "pkg.tar.gz")], { encoding: "utf8", maxBuffer: 64 << 20 });
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.split("\n").includes("./package.json"), "the box gets this package's working tree");
    assert.ok(!listed.stdout.split("\n").some((f) => /(^|\/)package-lock\.json$/.test(f) && f.split("/").length === 2), "and no lockfile with it");

    // The install, offline, in a directory like the box's: this package.json with nothing to fetch, and no lockfile.
    const box = join(dir, "box");
    mkdirSync(box);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) delete pkg[field];
    writeFileSync(join(box, "package.json"), JSON.stringify(pkg));
    const [npm, ...args] = PACKAGE_INSTALL;
    const r = spawnSync(npm, [...args, "--prefix", box, "--offline", "--ignore-scripts"], { encoding: "utf8", env: { ...process.env, npm_config_cache: join(dir, "cache") } });
    assert.equal(r.status, 0, `${PACKAGE_INSTALL.join(" ")} in a directory without a lockfile: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
