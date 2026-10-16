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
const { buildSnapshot, DEMO_EXTRA, DEMO_PACKS, deleteSnapshot, demoClosure, ledger, NotOursError, SNAPSHOT_BASE, snapshotDockerfile } = await import("./live/_p9.ts");
/** This checkout's own commit: the demo closure is read from its lockfile with git, which a shallow clone has too. */
const HEAD = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

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

it("the demo variant: one more layer with the packs' stand-ins and pi-codemode over the package's dependencies, pinned to the lockfile, npm's cache kept", () => {
  const plain = snapshotDockerfile(HEAD).trimEnd().split("\n");
  const demo = snapshotDockerfile(HEAD, { demo: true }).trimEnd().split("\n");
  assert.equal(demo.length, plain.length + 1);
  assert.equal(demo.at(-1), "USER daytona");
  assert.ok(plain.join("\n").includes("rm -rf /root/.npm") && !demo.join("\n").includes("rm -rf /root/.npm"), "a box's offline install resolves pi-codemode's spec from the cache");
  const layer = demo.find((l) => l.includes("--install-links"))!;
  const decoded = [...layer.matchAll(/echo ([A-Za-z0-9+/=]+) \| base64 -d > ([^\s;]+)/g)].map(([, b64, to]) => ({ to, json: JSON.parse(Buffer.from(b64!, "base64").toString()) as Record<string, Record<string, string>> }));
  const root = decoded.find((d) => d.to.endsWith("pi-durable-disk/package.json"))!.json;
  const disk = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
  for (const [name, spec] of Object.entries({ ...disk.dependencies, ...disk.devDependencies })) assert.equal(root.dependencies![name], spec, `the package's own ${name} stays as declared`);
  assert.equal(root.dependencies!["@earendil-works/pi-codemode"], DEMO_EXTRA[0]!.split("@").at(-1));
  for (const dir of DEMO_PACKS) assert.ok(Object.values(root.dependencies!).includes(`file:/opt/pda-demo/stubs/${dir}`), dir);
  assert.ok(Object.keys(root.overrides!).every((name) => !(name in root.dependencies!)), "npm refuses an override of a direct dependency");
  assert.equal(decoded.filter((d) => d.to.startsWith("/opt/pda-demo/stubs/")).length, DEMO_PACKS.length);
  assert.ok(layer.includes("mv /tmp/disk-package.json"), "the package's own package.json goes back, so its dependency stamp holds");
});

it("the demo closure: each pack's dependency fields, every single-version package of their closure at the lockfile's version, a version the lockfile holds twice left to npm", () => {
  const { stubs, pins } = demoClosure(HEAD);
  const pack = (dir: string) => JSON.parse(readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")) as Record<string, unknown>;
  for (const dir of DEMO_PACKS) {
    const p = pack(dir);
    assert.deepEqual(stubs[dir], Object.fromEntries(["name", "version", "dependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies"].filter((k) => p[k] !== undefined).map((k) => [k, p[k]])), dir);
  }
  for (const dir of DEMO_PACKS) assert.equal(pins[String(pack(dir).name)], undefined, `${dir} comes from the box's own tarball`);
  assert.equal(pins.typebox, undefined, "typebox is pinned exactly by two packs at two versions: npm nests it");
  assert.equal(pins["@parcha/agentrun-jev"], String(pack("jev").version), "jev is not a pack: npm, at the workspace's version");
  const lock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string }> };
  assert.equal(pins["@browserbasehq/stagehand"], lock.packages["node_modules/@browserbasehq/stagehand"]!.version, "a direct dependency of a pack, at the lockfile's version");
  assert.ok(Object.keys(pins).length > 50, "the closure, not only the direct dependencies");
});

it("the snapshot script refuses to run without a shared state directory, before it loads a helper or reaches Daytona", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["PDA_STATE_DIR", "PDA_P9_STATE", "DAYTONA_API_KEY"].includes(k)));
  const r = spawnSync(process.execPath, [new URL("./live/daytona-snapshot.ts", import.meta.url).pathname, "delete", "pda-p9-runtime-x"], { encoding: "utf8", env: { ...env, PDA_LIVE: "1" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /set PDA_STATE_DIR/);
  assert.doesNotMatch(r.stderr, /live suite ledgers/, "no temporary ledger was made");
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
