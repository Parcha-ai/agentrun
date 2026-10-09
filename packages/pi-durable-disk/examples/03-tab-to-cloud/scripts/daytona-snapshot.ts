// The demo's Daytona runtime snapshot, `pda-demo-runtime-<digest>`: a sandbox from a default snapshot gets the pinned
// runtime and the app (daytona.ts's prepareScript and appBundle; the digest covers both), stops, and is snapshotted.
// The build sandbox is deleted once the snapshot is active. Both are recorded in the ledger; the snapshot stays until
// `--delete`. Prints the snapshot's name.
//   with-daytona -- node scripts/daytona-snapshot.ts [--from daytona-medium] [--ledger F]
//   with-daytona -- node scripts/daytona-snapshot.ts --gpu [--ledger F]
// --gpu builds the GPU class's snapshot from gpuDockerfile instead (a GPU box is ephemeral and cannot be stopped and
// snapshotted): the runtime and the app's dependencies, one GPU of GPU_TYPES, 4 vCPU, 16 GiB.
//   with-daytona -- node scripts/daytona-snapshot.ts --delete pda-demo-runtime-<digest> [--ledger F]
import { parseArgs } from "node:util";
import { daytonaRest, LABEL_FLEET, LABEL_RUN, sandboxName, type SandboxInfo } from "@parcha/pi-durable-disk";
import { createHash } from "node:crypto";
import { appBundle, gpuDockerfile, prepareScript } from "../pipe/daytona.ts";
import { Ledger } from "../pipe/control.ts";

const { values } = parseArgs({ options: { from: { type: "string", default: "daytona-medium" }, ledger: { type: "string" }, delete: { type: "string" }, gpu: { type: "boolean", default: false } } });
/** A snapshot names one GPU type; the H100 is the one with capacity in the region (daytona-gpu's). */
const GPU_TYPES = ["H100"];
const apiKey = process.env.DAYTONA_API_KEY;
if (!apiKey) throw new Error("DAYTONA_API_KEY is needed (run through with-daytona)");
const apiUrl = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
const target = process.env.DAYTONA_TARGET || "us";
const ledger = values.ledger ? new Ledger(values.ledger) : undefined;
const client = daytonaRest({ apiKey, apiUrl });
const FLEET = "demo";
const PREFIX = "pda-demo-runtime-";
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

const snapshotState = async (name: string) => {
  const r = await api("GET", `/snapshots/${encodeURIComponent(name)}`);
  return r.status === 200 ? { state: String(r.json?.state), id: String(r.json?.id), error: r.json?.errorReason } : null;
};

if (values.delete) {
  if (!values.delete.startsWith(PREFIX)) throw new Error(`refusing to delete ${values.delete}: not one of this demo's snapshots`);
  const s = await snapshotState(values.delete);
  if (!s) log("snapshot.absent", { name: values.delete });
  else {
    const r = await api("DELETE", `/snapshots/${encodeURIComponent(s.id)}`);
    if (r.status >= 300) throw new Error(`deleting ${values.delete}: ${r.status}`);
    ledger?.close("daytona-snapshot", values.delete, "deleted");
    log("snapshot.deleted", { name: values.delete });
  }
  process.exit(0);
}

if (values.gpu) {
  const dockerfile = gpuDockerfile(process.getuid!(), process.getgid!());
  const name = `${PREFIX}gpu-${createHash("sha256").update(dockerfile).update(GPU_TYPES.join(",")).digest("hex").slice(0, 12)}`;
  const existing = await snapshotState(name);
  if (existing?.state === "active") {
    log("snapshot.exists", { name });
    console.log(name);
    process.exit(0);
  }
  if (existing) throw new Error(`snapshot ${name} exists in state ${existing.state}; delete it first`);
  const t0 = Date.now();
  const made = await api("POST", "/snapshots", { name, buildInfo: { dockerfileContent: dockerfile }, gpu: 1, gpuType: GPU_TYPES, cpu: 4, memory: 16, disk: 20, entrypoint: ["sleep", "infinity"] });
  if (made.status >= 300) throw new Error(`creating snapshot ${name}: ${made.status} ${JSON.stringify(made.json).slice(0, 400)}`);
  ledger?.open("daytona-snapshot", name, "GPU class, from a Dockerfile");
  for (let i = 0; ; i++) {
    const s = await snapshotState(name);
    if (s?.state === "active") break;
    if (s && ["error", "build_failed"].includes(s.state)) throw new Error(`snapshot ${name} went to ${s.state}: ${s.error}`);
    if (i >= 600) throw new Error(`snapshot ${name} not active after 20 min (${s?.state})`);
    if (i % 15 === 0) log("snapshot.waiting", { state: s?.state ?? "absent", ms: Date.now() - t0 });
    await sleep(2_000);
  }
  log("snapshot.active", { name, ms: Date.now() - t0 });
  console.log(name);
  process.exit(0);
}

const bundle = appBundle();
// A GPU base gets its own name: the same app on another image.
const name = `${PREFIX}${values.from === "daytona-medium" ? "" : `${values.from!.replace(/^daytona-/, "")}-`}${bundle.digest.slice(0, 12)}`;
const existing = await snapshotState(name);
if (existing?.state === "active") {
  log("snapshot.exists", { name });
  console.log(name);
  process.exit(0);
}
if (existing) throw new Error(`snapshot ${name} exists in state ${existing.state}; delete it first`);

const t0 = Date.now();
const boxName = sandboxName("pda-demo-build-", "runtime", t0);
ledger?.open("daytona-box", boxName, `builds ${name}`);
// A GPU box is ephemeral (Daytona deletes it when it stops), so it is snapshotted while it runs.
const ephemeral = /gpu/.test(values.from!);
let box: SandboxInfo;
try {
  box = await client.create({ name: boxName, snapshot: values.from!, target, labels: { [LABEL_FLEET]: FLEET, [LABEL_RUN]: "snapshot-build" }, autoStopInterval: 0, autoDeleteInterval: ephemeral ? 0 : -1, ttlMinutes: 60 });
} catch (error) {
  ledger?.close("daytona-box", boxName, `create failed, no box: ${(error as Error).message.slice(0, 120)}`);
  throw error;
}
const ours = (b: SandboxInfo | null) => {
  if (!b || b.labels?.[LABEL_FLEET] !== FLEET || !b.name.startsWith("pda-demo-build-")) throw new Error(`refusing to touch sandbox ${b?.id}: not this build's`);
  return b;
};
try {
  for (let i = 0; box.state !== "started"; i++) {
    if (i >= 600) throw new Error(`${boxName} did not start in 10 min (last state ${box.state})`);
    if (i % 15 === 0) log("box.waiting", { state: box.state, ms: Date.now() - t0 });
    await sleep(1_000);
    box = ours(await client.get(box.id));
  }
  log("box.started", { box: boxName, ms: Date.now() - t0 });
  await client.upload(box, "/tmp/pda-demo-app.tar.gz", bundle);
  const r = await client.exec(box, prepareScript(process.getuid!(), process.getgid!()), 900);
  if (r.exitCode !== 0) throw new Error(`prepare failed (${r.exitCode}): ${r.result.trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  log("box.prepared", { ms: Date.now() - t0, steps: r.result.split("\n").filter((l) => l.startsWith("step")).map((l) => l.split("\t").slice(1).join("=")) });
  if (!ephemeral) {
    await client.stop(box.id, false);
    for (let i = 0; box.state !== "stopped" && i < 300; i++) {
      await sleep(1_000);
      box = ours(await client.get(box.id));
    }
    log("box.stopped", { ms: Date.now() - t0 });
  }
  const made = await api("POST", `/sandbox/${encodeURIComponent(box.id)}/snapshot`, { name });
  if (made.status >= 300) throw new Error(`creating snapshot ${name}: ${made.status} ${JSON.stringify(made.json).slice(0, 300)}`);
  ledger?.open("daytona-snapshot", name, `from ${values.from}`);
  for (let i = 0; i < 900; i++) {
    const s = await snapshotState(name);
    if (s?.state === "active") break;
    if (s && ["error", "build_failed"].includes(s.state)) throw new Error(`snapshot ${name} went to ${s.state}: ${s.error}`);
    if (i % 15 === 0) log("snapshot.waiting", { state: s?.state ?? "absent", ms: Date.now() - t0 });
    await sleep(2_000);
  }
  log("snapshot.active", { name, ms: Date.now() - t0 });
} finally {
  await client.remove(box.id).catch((error) => log("box.delete-failed", { error: (error as Error).message }));
  ledger?.close("daytona-box", boxName, "deleted");
  log("box.deleted", { box: boxName, minutes: Number(((Date.now() - t0) / 60_000).toFixed(2)) });
}
console.log(name);
