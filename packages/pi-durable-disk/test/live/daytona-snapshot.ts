// The runtime snapshot for Daytona boxes, one command per invocation, with the Daytona key in the environment:
//   PDA_LIVE=1 DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts build <commit>     build pda-p9-runtime-<commit>-<stamp>
//   PDA_LIVE=1 DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts check <name>       boot one box from it, prepare, delete
//   PDA_LIVE=1 DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts baseline           the same on daytona-medium (prepareBox)
//   PDA_LIVE=1 DAYTONA_API_KEY=... node test/live/daytona-snapshot.ts delete <name>
// A box from the snapshot holds Node, the archil client, the run user, the wrapper and the package's dependencies, so a
// daytonaHost start with `snapshot: <name>` and `prepare: prepareOnSnapshot` boots in seconds instead of installing them.
// The snapshot and every box go into P9-STATE.json first; results merge into P9-PROBE.json. Nothing prints a key.
import { LABEL_FLEET, type SandboxInfo } from "../../src/hosts/daytona.ts";
import { buildSnapshot, confirmGone, deleteSnapshot, FLEET, getSnapshot, guardedClient, ledger, LIVE_DAYTONA, NAME_PREFIX, NODE, PACKAGE_DIR, prepareBox, prepareOnSnapshot, record, sh } from "./_p9.ts";

const TARGET = process.env.DAYTONA_TARGET || "us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!LIVE_DAYTONA) throw new Error("PDA_LIVE=1 and DAYTONA_API_KEY (with-daytona) are required");
const [command, arg] = process.argv.slice(2);

/** One box from `snapshot`, timed from the create call to `started`, then prepared, then deleted and confirmed gone. */
async function boot(snapshot: string, prepare: typeof prepareBox, purpose: string) {
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
    const imported = (await sh(client, box, `sudo -n -u pda ${NODE} -e "import('${PACKAGE_DIR}/dist/index.js').then((m) => console.log('exports', Object.keys(m).length))"`)).trim();
    return { snapshot, startedMs, prepareMs: prepared.ms, steps: prepared.steps, versions: prepared.versions, readyMs, imported };
  } finally {
    await client.remove(id).catch(() => {});
    ledger.deleted(id, "deleted by the snapshot script");
    const left = await confirmGone(client, 180_000);
    if (left.length) console.error(`not confirmed gone yet: ${left.length} box(es); see P9-STATE.json`);
  }
}

switch (command) {
  case "build": {
    if (!arg || !/^[0-9a-f]{40}$/.test(arg)) throw new Error("build takes the full sha of a commit on the public repository");
    const name = `${NAME_PREFIX}runtime-${arg.slice(0, 8)}-${Date.now().toString(36)}`;
    const built = await buildSnapshot(name, arg);
    record("snapshot-build", { ...built.facts, commit: arg, ms: built.ms });
    console.log(JSON.stringify({ ...built.facts, commit: arg, ms: built.ms }));
    if (built.facts.state !== "active") process.exit(1);
    break;
  }
  case "check": {
    if (!arg || !(await getSnapshot(arg))) throw new Error(`no snapshot ${arg}`);
    const result = await boot(arg, prepareOnSnapshot, "snapcheck");
    record("snapshot-check", result);
    console.log(JSON.stringify({ ...result, spendUsd: ledger.spend() }));
    break;
  }
  case "baseline": {
    const result = await boot("daytona-medium", prepareBox, "snapbase");
    record("snapshot-baseline", result);
    console.log(JSON.stringify({ ...result, spendUsd: ledger.spend() }));
    break;
  }
  case "delete": {
    if (!arg) throw new Error("delete takes the snapshot's name");
    console.log(JSON.stringify({ name: arg, status: await deleteSnapshot(arg), after: await getSnapshot(arg) }));
    break;
  }
  default:
    throw new Error("usage: daytona-snapshot.ts build <commit> | check <name> | baseline | delete <name>");
}
