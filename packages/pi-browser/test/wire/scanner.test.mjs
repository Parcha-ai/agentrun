import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { LEAKS, makeLeakyExtension } from "./leaky-fixture.mjs";
import { call, collect, openRig } from "./rig.mjs";
import { Scan, proveScannerSees } from "./scan.mjs";
import { makeSentinels } from "./sentinels.mjs";
import { scratchSync } from "../fixtures/scratch.mjs";


async function scanRun(t, tool, sentinels) {
  const dir = scratchSync(t, "wire-scan-");
  const evidenceDir = path.join(dir, "evidence");
  const rig = await openRig({ dir, script: [[call(tool)]], install: (registry) => registry.install(makeLeakyExtension({ secret: sentinels.bbSigningKey, evidenceDir, onSession: (row, change) => rig.host(row, change) })) });
  await rig.run();
  const scan = new Scan(sentinels);
  await collect(rig, scan, { evidenceDirs: [evidenceDir] });
  await rig.close();
  return { scan, dir };
}

test("the scanner sees every sentinel in every encoding it checks", () => {
  const proof = proveScannerSees(makeSentinels());
  assert.deepEqual(proof.missed, []);
  assert.ok(proof.forms > 100);
});

test("green on a clean run, with coverage in every source", async (t) => {
  const { scan } = await scanRun(t, "clean", makeSentinels());
  assert.equal(scan.report(), "no sentinel found");
  for (const source of ["entries", "model-requests", "onSession", "logs", "evidence", "run.sqlite:raw", "run.sqlite:document_revisions", "run.sqlite:entries"]) {
    const covered = scan.coverageOf(source);
    assert.ok(covered.bytes > 0 || covered.records > 0, `${source} was not covered`);
  }
});

for (const [tool, { source, note }] of Object.entries(LEAKS)) {
  test(`red on a planted leak: ${note}`, async (t) => {
    const { scan } = await scanRun(t, tool, makeSentinels());
    assert.ok(scan.findings.some((f) => f.sentinel === "bbSigningKey" && f.source.startsWith(source)), `no finding in ${source}:\n${scan.report()}`);
  });
}

for (const token of ["kernelJwt", "bbLiveViewToken", "pageToken"]) {
  test(`red on a leak of the ${token} alone`, async (t) => {
    const sentinels = makeSentinels();
    const dir = scratchSync(t, "wire-scan-");
    const evidenceDir = path.join(dir, "evidence");
    const rig = await openRig({ dir, script: [[call("leak_result")]], install: (registry) => registry.install(makeLeakyExtension({ secret: sentinels[token], evidenceDir, onSession: () => {} })) });
    await rig.run();
    const scan = new Scan(sentinels);
    await collect(rig, scan, { evidenceDirs: [evidenceDir] });
    await rig.close();
    assert.ok(scan.findings.some((f) => f.sentinel === token), `${token} not found:\n${scan.report()}`);
  });
}
