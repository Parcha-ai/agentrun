// The Daytona runtime snapshot's recipe and guards (test/live/_p9.ts), offline: no key, no box, no snapshot built.
import { after, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pda-live-snapshot-"));
after(() => rmSync(dir, { recursive: true, force: true }));
// The ledger this test writes, never the lane's own: set before the helper reads it.
process.env.PDA_P9_STATE = join(dir, "P9-STATE.json");
const { buildSnapshot, deleteSnapshot, ledger, NotOursError, SNAPSHOT_BASE, snapshotDockerfile } = await import("./live/_p9.ts");

const COMMIT = "c91bbb9cc0dd9485fe857bb00940bde07eaad1e7";

it("the snapshot's Dockerfile: daytona-medium's image, the pinned and checked runtime, this package's dependencies at one commit, no build context, the toolbox user restored", () => {
  for (const bad of ["c91bbb9c", "main", `${COMMIT}x`, COMMIT.toUpperCase()]) assert.throws(() => snapshotDockerfile(bad), /full commit sha/, bad);
  const lines = snapshotDockerfile(COMMIT).trimEnd().split("\n");
  assert.equal(lines[0], `FROM ${SNAPSHOT_BASE}`);
  assert.equal(lines.at(-1), "USER daytona", "the base image's toolbox user, so daytonaHost's sudo default holds");
  assert.equal(lines.filter((l) => /^(ADD|COPY)\b/.test(l)).length, 0, "nothing from a build context");
  const text = lines.join("\n");
  assert.equal((text.match(/sha256sum -c -/g) ?? []).length, 2, "Node and the archil client are both checked");
  assert.ok(text.includes(`https://raw.githubusercontent.com/Parcha-ai/agentrun/${COMMIT}/packages/pi-durable-disk/package.json`), "the dependencies of one commit");
  assert.ok(!/\$\{|undefined/.test(text), "every value filled in");
});

it("the dependency stamp: the box's one-liner hashes the dependency fields in a stable order, and any change to them changes it", () => {
  const script = /-e '([^']+)'/.exec(snapshotDockerfile(COMMIT))?.[1];
  assert.ok(script, "the hash one-liner is in the recipe");
  const hash = (pkg: unknown) => {
    const file = join(dir, `pkg-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(pkg));
    const r = spawnSync(process.execPath, ["-e", script, file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
  const same = hash(pkg);
  assert.match(same, /^[0-9a-f]{64}$/);
  const reordered = { ...pkg, devDependencies: Object.fromEntries(Object.entries(pkg.devDependencies ?? {}).reverse()) };
  assert.equal(hash(reordered), same, "key order does not matter");
  assert.equal(hash({ ...pkg, version: "9.9.9", scripts: {} }), same, "fields other than the dependency ones do not matter");
  assert.notEqual(hash({ ...pkg, dependencies: { ...pkg.dependencies, extra: "1.0.0" } }), same, "a new dependency does");
  assert.notEqual(hash({ ...pkg, devDependencies: { ...pkg.devDependencies, "@earendil-works/chord": "9.9.9" } }), same, "a new version does");
});

it("a snapshot is built only under this lane's prefix and deleted only when this lane's ledger built it; a kept one leaves the ledger closed", async () => {
  await assert.rejects(buildSnapshot("daytona-medium", COMMIT), NotOursError, "never a default");
  await assert.rejects(buildSnapshot("pda-p9-Bad_Name", COMMIT), NotOursError);
  await assert.rejects(deleteSnapshot("daytona-medium"), NotOursError);
  await assert.rejects(deleteSnapshot("pda-p9-runtime-someone-elses"), NotOursError, "not in this ledger");
  ledger.snapshotCreating("pda-p9-runtime-t", COMMIT, "test");
  assert.equal(ledger.read().closed, false, "a snapshot just built is open");
  ledger.snapshotSettled("pda-p9-runtime-t", { state: "active", kept: "the next take" });
  assert.equal(ledger.read().closed, true, "kept on purpose, and named");
  assert.ok(ledger.snapshotNames().has("pda-p9-runtime-t"));
  ledger.snapshotDeleted("pda-p9-runtime-t");
  assert.equal(ledger.snapshotNames().has("pda-p9-runtime-t"), false);
});
