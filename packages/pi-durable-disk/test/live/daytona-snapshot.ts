// The runtime snapshot for Daytona boxes, one command per invocation, with the Daytona key in the environment:
//   PDA_LIVE=1 PDA_STATE_DIR=<dir> DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts build <commit>     build pda-p9-runtime-<commit>-<stamp>
//   PDA_LIVE=1 PDA_STATE_DIR=<dir> DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts build <commit> --demo   the demo variant (pda-p9-runtime-demo-...)
//   PDA_LIVE=1 PDA_STATE_DIR=<dir> DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts check <name>       boot one box from it, prepare, delete
//   PDA_LIVE=1 PDA_STATE_DIR=<dir> DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts check-demo <name> [--online]   and install the demo's packs
//   PDA_LIVE=1 PDA_STATE_DIR=<dir> DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts baseline           the same on daytona-medium (prepareBox)
//   PDA_LIVE=1 PDA_STATE_DIR=<dir> DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts delete <name>
// A box from the snapshot holds Node, the archil client, the run user, the wrapper and the package's dependencies, so a
// daytonaHost start with `snapshot: <name>` and `prepare: prepareOnSnapshot` boots in seconds instead of installing them.
// The snapshot and every box go into P9-STATE.json first; results merge into P9-PROBE.json. Nothing prints a key.
// PDA_STATE_DIR (or PDA_P9_STATE) is required and must be the same for every command: `delete` deletes only a snapshot
// that ledger recorded, and a box only counts as gone once that ledger confirms it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL_FLEET, type DaytonaClient, type SandboxInfo } from "../../src/hosts/daytona.ts";

// Before the helpers load: without a shared state directory each run would get a temporary ledger of its own.
if (!process.env.PDA_STATE_DIR && !process.env.PDA_P9_STATE) throw new Error("set PDA_STATE_DIR (the same for build, check and delete): the ledger that delete and the spend read lives there");
const { buildSnapshot, confirmGone, DEMO_EXTRA, DEMO_PACKS, deleteSnapshot, FLEET, getSnapshot, guardedClient, installDemoPacks, LEDGER, ledger, LIVE_DAYTONA, NAME_PREFIX, NODE, PACKAGE_DIR, prepareBox, prepareOnSnapshot, record } = await import("./_p9.ts");

const TARGET = process.env.DAYTONA_TARGET || "us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!LIVE_DAYTONA) throw new Error("PDA_LIVE=1 and DAYTONA_API_KEY (with-daytona) are required");
const [command, arg] = process.argv.slice(2);

/** A box ships this checkout's built package (and, for the demo, the packs): refuse before a paid box exists. */
function requireBuilt(dirs: readonly string[]) {
  const missing = dirs.filter((dir) => !existsSync(fileURLToPath(new URL(`../../../${dir}/dist/index.js`, import.meta.url))));
  if (missing.length) throw new Error(`not built: ${missing.join(", ")} (run npm run build at the repository root first)`);
}

/** One box from `snapshot`, timed from the create call to `started`, then prepared, then deleted and confirmed gone. */
async function boot(snapshot: string, prepare: (client: DaytonaClient, box: SandboxInfo) => Promise<{ ms: number; steps: Record<string, number>; versions?: Record<string, string> }>, purpose: string, imports = [`${PACKAGE_DIR}/dist/index.js`]) {
  const client = guardedClient();
  const name = `${NAME_PREFIX}${purpose}-${Date.now().toString(36)}`;
  const t0 = performance.now();
  let box: SandboxInfo | null = await client.create({
    name,
    snapshot,
    target: TARGET,
    labels: { [LABEL_FLEET]: FLEET, "pda-p9": purpose },
    autoStopInterval: 0,
    autoDeleteInterval: 0,
    ttlMinutes: 30,
  });
  const id = box.id;
  let failed = false;
  try {
    while (box?.state !== "started") {
      if (!box || box.state === "error" || box.state === "build_failed" || performance.now() - t0 > 600_000) throw new Error(`box ${name} is ${box?.state ?? "gone"}`);
      await sleep(500);
      box = await client.get(id);
    }
    const startedMs = Math.round(performance.now() - t0);
    const prepared = await prepare(client, box);
    const readyMs = Math.round(performance.now() - t0);
    // The checkout's dist, as the run user, against the dependencies the box holds: what the launcher runs.
    // Each import on its own, as the run user, from the package directory: which ones load, and why one does not.
    const list = imports.map((m) => `'${m}'`).join(", ");
    const probe = `for (const m of [${list}]) { try { const x = await import(m); console.log('ok', m, Object.keys(x).length); } catch (e) { console.log('FAIL', m, String(e.message).split('\\n')[0].slice(0, 240)); } }`;
    const ran = await client.exec(box, `cd ${PACKAGE_DIR} && sudo -n -u pda ${NODE} --input-type=module -e "${probe}"`, 120);
    const imported = ran.result.trim().split("\n");
    // Every import is listed, and the command still fails after: a snapshot whose package does not load never passes.
    const importsOk = ran.exitCode === 0 && imports.every((m) => imported.some((line) => line.startsWith(`ok ${m} `)));
    return { snapshot, startedMs, prepareMs: prepared.ms, steps: prepared.steps, versions: prepared.versions, readyMs, imported, importsOk, probeExit: ran.exitCode };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // Stamped deleted only once the delete call succeeded; gone only once Daytona says so. Otherwise the command fails.
    const removed = await client.remove(id).then(() => true, (error: unknown) => (console.error(`deleting box ${id} failed: ${(error as Error).message}`), false));
    if (removed) ledger.deleted(id, "deleted by the snapshot script");
    const left = await confirmGone(client, 180_000);
    if (left.length) {
      const open = new Error(`${left.length} box(es) not confirmed gone (${left.join(", ")}): the ledger ${LEDGER} keeps them open; delete them by id`);
      if (failed) console.error(open.message);
      else throw open;
    }
  }
}

switch (command) {
  case "build": {
    if (!arg || !/^[0-9a-f]{40}$/.test(arg)) throw new Error("build takes the full sha of a commit on the public repository");
    const name = `${NAME_PREFIX}runtime-${arg.slice(0, 8)}-${Date.now().toString(36)}`;
    const demo = process.argv.includes("--demo");
    const built = await buildSnapshot(demo ? name.replace(`${NAME_PREFIX}runtime-`, `${NAME_PREFIX}runtime-demo-`) : name, arg, { demo });
    record("snapshot-build", { ...built.facts, commit: arg, ms: built.ms });
    console.log(JSON.stringify({ ...built.facts, commit: arg, ms: built.ms }));
    if (built.facts.state !== "active") process.exit(1);
    break;
  }
  case "check": {
    requireBuilt(["pi-durable-disk"]);
    if (!arg || !(await getSnapshot(arg))) throw new Error(`no snapshot ${arg}`);
    const result = await boot(arg, prepareOnSnapshot, "snapcheck");
    record("snapshot-check", result);
    console.log(JSON.stringify({ ...result, spendUsd: ledger.spend() }));
    if (!result.importsOk) throw new Error(`the box did not load every import (probe exit ${result.probeExit}): see "imported" above`);
    break;
  }
  case "check-demo": {
    requireBuilt(["pi-durable-disk", ...DEMO_PACKS]);
    if (!arg || !(await getSnapshot(arg))) throw new Error(`no snapshot ${arg}`);
    const online = process.argv.includes("--online");
    // This checkout's packs, as the demo's box gets them (each package must be built: npm run build at the root).
    const packs = mkdtempSync(join(tmpdir(), "pda-demo-packs-"));
    try {
      for (const dir of DEMO_PACKS) {
        const r = spawnSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", packs], { cwd: fileURLToPath(new URL(`../../../${dir}/`, import.meta.url)), encoding: "utf8" });
        if (r.status !== 0) throw new Error(`npm pack ${dir}: ${r.stderr}`);
      }
      const tarballs = readdirSync(packs).map((f) => join(packs, f));
      // Every entry of the packs (and DEMO_EXTRA) the disk demo's child imports. agentrun-pi's root is not one: it needs the
      // Pi host's own packages, optional peers a box without Pi does not have.
      const imports = [
        `${PACKAGE_DIR}/dist/index.js`,
        ...["agentrun-dsl", "agentrun-dsl/recovery", "agentrun-pi/durable", "pi-browser", "pi-browser/driver/stagehand", "pi-browser/durable", "pi-browser/providers/cdp", "pi-browser/testing"].map((e) => `@parcha/${e}`),
        ...["pi-transport", "pi-transport/box/docker", "pi-transport/box/local", "pi-transport/hands", "pi-vision", "pi-vision/durable", "pi-vision/node", "pi-vision/testing"].map((e) => `@parcha/${e}`),
        ...DEMO_EXTRA.map((s) => s.slice(0, s.lastIndexOf("@"))),
      ];
      const result = await boot(arg, async (client, box) => {
        const t0 = performance.now();
        const disk = await prepareOnSnapshot(client, box);
        const demo = await installDemoPacks(client, box, tarballs, { offline: !online });
        return { ms: Math.round(performance.now() - t0), steps: { ...disk.steps, ...Object.fromEntries(Object.entries(demo.steps).map(([k, v]) => [`demo.${k}`, v])) }, versions: disk.versions };
      }, online ? "snapdemo-online" : "snapdemo", imports);
      record(online ? "snapshot-check-demo-online" : "snapshot-check-demo", result);
      console.log(JSON.stringify({ ...result, online, spendUsd: ledger.spend() }));
      if (!result.importsOk) throw new Error(`the box did not load every import (probe exit ${result.probeExit}): see "imported" above`);
    } finally {
      rmSync(packs, { recursive: true, force: true });
    }
    break;
  }
  case "baseline": {
    requireBuilt(["pi-durable-disk"]);
    const result = await boot("daytona-medium", prepareBox, "snapbase");
    record("snapshot-baseline", result);
    console.log(JSON.stringify({ ...result, spendUsd: ledger.spend() }));
    if (!result.importsOk) throw new Error(`the box did not load every import (probe exit ${result.probeExit}): see "imported" above`);
    break;
  }
  case "delete": {
    if (!arg) throw new Error("delete takes the snapshot's name");
    const deleted = await deleteSnapshot(arg);
    console.log(JSON.stringify({ name: arg, ...deleted, after: await getSnapshot(arg) }));
    if (!deleted.gone) throw new Error(`snapshot ${arg} is still listed after its delete was accepted: look again later`);
    break;
  }
  default:
    throw new Error("usage: daytona-snapshot.ts build <commit> [--demo] | check <name> | check-demo <name> [--online] | baseline | delete <name>");
}
