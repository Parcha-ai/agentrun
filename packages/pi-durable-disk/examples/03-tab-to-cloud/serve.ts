// Start the demo: the page, the pipe, and where a run goes when its tab is gone.
//
//   node serve.ts [--port 8790] [--host 127.0.0.1] [--run ID] [--local DIR]
//                 --model ID --model-url URL [--model-key-env NAME] [--budget 400000]
//                 [--judge-model ID [--judge-url URL] [--judge-key-env NAME]]
//                 [--creature-dir DIR]   the creature page's built folder, served under /tab/ (default: 04-walks-home/tab/dist when built); /tab/offline.json lists what a checkout caches
//                 [--show-dir DIR]   the stage's built files, served under /show/ on this origin (isolation headers like the tab's; /show/offline.json lists what a checkout caches)
//                 [--models-dir DIR]   the robot model's files, served under /models/ (default: $DEMO_MODELS_DIR): the page's local brain loads them from there and keeps them
//                                      in OPFS (D1's v5: its parts, <model>.parts.json, <model>.serving.json, the warm state <model>.state.bin and its sidecar)
//                 [--brain-judge jev | --brain-judge-module PATH]   the question the page's brain router asks (POST /api/runs/<id>/brain-judge): jev (needs TYPESAFE_API_KEY), or a module whose default export is a judge runner (checks)
//                 [--mount-root /mnt/pda/demo/pipe] [--ledger DEMO-STATE.json] [--log FILE] [--cloud none|local|daytona|remote-local]
//                 [--cloud-module PATH [--cloud-arg KEY=VALUE]...]   a cloud host from a module: its default export takes CloudModuleOptions
//                 [--no-restore PREFIX]...   work/ prefixes no writer is sent on attach (a large result read on demand through the disk proxy)
//                 [--instructions-file F --instructions-mode replace|append]   the host's own instructions for the agent, in place of the robot page's or after them (the mode has no default)
//                 [--without-extensions a,b]   extensions (by name) the page leaves out of the agent: their tools are not offered
//                 [--placer-module PATH [--placer-arg KEY=VALUE]...]  where the run should be, decided by a typed question (placement.ts) on each user message
//                 [--daytona-snapshot NAME] [--daytona-gpu-snapshot NAME [--warm-gpu]] [--daytona-secret NAME | --cloud-link]
//                 [--parent-pid PID]   stop when that process is gone (a harness names its own pid: if it is killed, its server does not outlive it)
//                 [--also-host ADDR] [--public-url https://HOST] [--tab-writable PATH,PATH] [--evidence-readback]
//
// --also-host listens on a second address too (a reverse proxy's side of a bridge); --public-url is the address the
// printed link uses (the proxy's). The admin routes (and POST /api/runs/<id>/attach) answer on loopback only, with the
// admin token. --tab-writable lists the work/ paths the page of the tab that holds a run may PUT (pipe/server.ts).
// --evidence-readback reads work/ back from the disk's object store after each release of the pipe's claim, with the
// server's own disk credential, and logs pipe.readback (pipe/readback.ts); never on the handover path.
//
// --model-key-env names the variable holding the model endpoint's key (sent by the pipe as a bearer token). A Daytona
// sandbox calls the model itself: its key is the Daytona secret --daytona-secret (Daytona puts a placeholder in the box
// and swaps in the key on requests to the endpoint's host), or, with --cloud-link, its calls come back through the pipe.
//
// With the disk: ARCHIL_API_KEY, PDA_LIVE_DISK (or ARCHIL_DISK) and PDA_LIVE_REGION (or ARCHIL_REGION) in the
// environment; the server holds the key, mints a mount token per claim and removes it after. With --local DIR, the
// "disk" is a local directory and there is no claim (for development of the page).
// It prints the run's link, `/run/<id>#<secret>`: the fragment is the run's secret.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { archilControl, jsonLog, Ledger } from "./pipe/control.ts";
import type { JudgeRunner } from "./brain-router.ts";
import type { Placer } from "./placement.ts";
import { appPolicyFromArgs } from "./app-policy.ts";
import { closeServerAndCloud } from "./shutdown.ts";
import { createDemoServer, type CloudHost, type CloudModuleOptions } from "./pipe/server.ts";
import { localClaim } from "./test/_local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8790" },
    host: { type: "string", default: "127.0.0.1" },
    run: { type: "string" },
    local: { type: "string" },
    model: { type: "string", default: process.env.DEMO_MODEL },
    "model-url": { type: "string", default: process.env.DEMO_MODEL_URL },
    "model-key-env": { type: "string" },
    "brain-judge": { type: "string" },
    "brain-judge-module": { type: "string" },
    "show-dir": { type: "string" },
    "models-dir": { type: "string", default: process.env.DEMO_MODELS_DIR },
    "creature-dir": { type: "string" },
    "judge-model": { type: "string" },
    "judge-url": { type: "string" },
    "judge-key-env": { type: "string" },
    "daytona-snapshot": { type: "string", default: process.env.DEMO_DAYTONA_SNAPSHOT },
    "daytona-secret": { type: "string" },
    "daytona-gpu-snapshot": { type: "string", default: process.env.DEMO_DAYTONA_GPU_SNAPSHOT },
    "warm-gpu": { type: "boolean", default: false },
    budget: { type: "string", default: "400000" },
    "mount-root": { type: "string", default: "/mnt/pda/demo/pipe" },
    ledger: { type: "string" },
    log: { type: "string" },
    cloud: { type: "string", default: "none" },
    "cloud-events": { type: "string" },
    "cloud-module": { type: "string" },
    "cloud-arg": { type: "string", multiple: true },
    "no-restore": { type: "string", multiple: true },
    "instructions-file": { type: "string" },
    "instructions-mode": { type: "string" },
    "without-extensions": { type: "string" },
    "placer-module": { type: "string" },
    "parent-pid": { type: "string" },
    "placer-arg": { type: "string", multiple: true },
    "cloud-link": { type: "boolean", default: false },
    "grace-ms": { type: "string", default: "5000" },
    "remote-start-ms": { type: "string" },
    "writer-return-ms": { type: "string" },
    "admin-token-file": { type: "string" },
    "also-host": { type: "string" },
    "tab-writable": { type: "string" },
    "evidence-readback": { type: "boolean", default: false },
    "public-url": { type: "string" },
  },
});

// A mistyped bound is reported before anything starts: a NaN would make every move time out at once, a zero or negative one the same.
if (values["parent-pid"] !== undefined && !/^[1-9]\d*$/.test(values["parent-pid"])) {
  console.error(`--parent-pid ${values["parent-pid"]}: it is the pid of a process, a positive whole number`);
  process.exit(2);
}
// What the host tells the page about its agent (its instructions, the extensions to leave out): a bad combination is an error here, before anything starts.
let appPolicy: ReturnType<typeof appPolicyFromArgs>;
try {
  appPolicy = appPolicyFromArgs({ ...(values["instructions-file"] !== undefined ? { file: values["instructions-file"] } : {}), ...(values["instructions-mode"] !== undefined ? { mode: values["instructions-mode"] } : {}), ...(values["without-extensions"] !== undefined ? { without: values["without-extensions"] } : {}) });
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
for (const name of ["grace-ms", "remote-start-ms", "writer-return-ms"] as const) {
  const text = values[name];
  if (text !== undefined && !(Number.isFinite(Number(text)) && Number(text) > 0 && text.trim() !== "")) {
    console.error(`--${name} ${text}: it is a positive number of milliseconds`);
    process.exit(2);
  }
}

const log = jsonLog(values.log);
if (!values.model || !values["model-url"]) {
  console.error("name the model: --model ID --model-url URL (an OpenAI-compatible endpoint with the Responses API), or DEMO_MODEL and DEMO_MODEL_URL");
  process.exit(2);
}
const modelKey = values["model-key-env"] ? process.env[values["model-key-env"]] : undefined;
// The dark-content judge a page asks before showing an answer (POST /api/runs/<id>/judge): its model, endpoint
// (default the model's) and the variable holding that endpoint's key. No --judge-model: no judge route. The flag only
// turns the route on: this example's page shows the agent's own model and does not call it; the Golden Gate episode's
// tab gates every answer of its trained model through it.
const judgeKey = values["judge-key-env"] ? process.env[values["judge-key-env"]] : undefined;
if (values["judge-key-env"] && !judgeKey) {
  console.error(`--judge-key-env ${values["judge-key-env"]}: that variable is not set`);
  process.exit(2);
}
// The question the page's brain router asks (POST /api/runs/<id>/brain-judge): `jev` is TypeSafe Jev (TYPESAFE_API_KEY in the environment: run under the credential wrapper). A check that must not spend names a module
// (`--brain-judge-module`) whose default export is a judge runner; there is no keyword stand-in in the server.
if (values["brain-judge"] !== undefined && values["brain-judge"] !== "jev") {
  console.error("--brain-judge: jev (a check names its own runner with --brain-judge-module)");
  process.exit(2);
}
if (values["brain-judge"] === "jev" && !process.env.TYPESAFE_API_KEY) {
  console.error("--brain-judge jev needs TYPESAFE_API_KEY in the environment");
  process.exit(2);
}
if (values["brain-judge"] !== undefined && values["brain-judge-module"] !== undefined) {
  console.error("--brain-judge and --brain-judge-module are one or the other");
  process.exit(2);
}
let brainJudge: JudgeRunner | undefined;
if (values["brain-judge"] === "jev") brainJudge = (await import("@parcha/agentrun-jev")).createJevRunner({ timeoutMs: 10_000, maxAttempts: 1 }) as unknown as JudgeRunner;
else if (values["brain-judge-module"] !== undefined) brainJudge = (await import(pathToFileURL(resolvePath(values["brain-judge-module"])).href)).default as JudgeRunner;
// The creature page (the robot) under /tab/ on this origin: its built folder (04-walks-home/tab/dist), by default when it has been built next to this example.
const creatureDir = values["creature-dir"] ? resolvePath(values["creature-dir"]) : existsSync(join(here, "..", "04-walks-home", "tab", "dist", "index.html")) ? join(here, "..", "04-walks-home", "tab", "dist") : undefined;
const judge = values["judge-model"]
  ? { baseUrl: values["judge-url"] ?? values["model-url"]!, model: values["judge-model"], ...(judgeKey ? { apiKey: judgeKey } : {}) }
  : undefined;
if (values["model-key-env"] && !modelKey) {
  console.error(`--model-key-env ${values["model-key-env"]}: the variable is not set`);
  process.exit(2);
}
const model = { baseUrl: values["model-url"]!, model: values.model!, budgetTokens: Number(values.budget), ...(modelKey ? { apiKey: modelKey } : {}) };
const disk = process.env.PDA_LIVE_DISK ?? process.env.ARCHIL_DISK ?? "dsk-local";
const region = process.env.PDA_LIVE_REGION ?? process.env.ARCHIL_REGION ?? "aws-us-east-1";
const ledger = values.ledger ? new Ledger(values.ledger) : undefined;
// The loopback admin route's token (faults for the demo), written to a 0600 file for a script on this machine.
let adminToken: string | undefined;
if (values["admin-token-file"]) {
  adminToken = randomBytes(24).toString("base64url");
  writeFileSync(values["admin-token-file"], `${adminToken}\n`, { mode: 0o600 });
}

let cloud: CloudHost | undefined;
if (values.cloud === "remote-local") {
  // A second host with no unit and no disk client: remote-host.ts as a child process, through the pipe.
  const { remoteLocalHost } = await import("./pipe/remote-local.ts");
  cloud = remoteLocalHost({ log });
}
if (values.cloud === "local" || values.cloud === "daytona") {
  const { cloudHost } = await import("./pipe/cloud.ts");
  cloud = await cloudHost(values.cloud as "local" | "daytona", {
    disk,
    region,
    log,
    ...(ledger ? { ledger } : {}),
    model,
    link: values["cloud-link"],
    ...(values["cloud-events"] ? { eventsLog: values["cloud-events"] } : {}),
    ...(values["daytona-snapshot"] ? { snapshot: values["daytona-snapshot"] } : {}),
    ...(values["daytona-secret"] ? { modelSecret: values["daytona-secret"] } : {}),
    ...(values["daytona-gpu-snapshot"] ? { gpuSnapshot: values["daytona-gpu-snapshot"] } : {}),
    ...(values["warm-gpu"] ? { warmGpu: true } : {}),
  });
}

const diskControl = values.local ? null : await archilControl({ disk, region, apiKey: process.env.ARCHIL_API_KEY ?? "" });

if (values["cloud-module"]) {
  // A cloud host from another example (04-walks-home/vm is the Modal VM): its default export takes these options and returns a CloudHost.
  const mod = (await import(pathToFileURL(resolvePath(values["cloud-module"])).href)) as { default: (options: CloudModuleOptions) => Promise<CloudHost> };
  const args = Object.fromEntries((values["cloud-arg"] ?? []).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  cloud = await mod.default({ disk, region, model, log, ...(ledger ? { ledger } : {}), ...(values["cloud-events"] ? { eventsLog: values["cloud-events"] } : {}), args });
}

let placer: Placer | undefined;
if (values["placer-module"]) {
  // Where a message should run: the module's default export takes { log, args } and returns a Placer (04-walks-home/vm/placer.ts asks TypeSafe Jev).
  const mod = (await import(pathToFileURL(resolvePath(values["placer-module"])).href)) as { default: (options: { log: typeof log; args: Record<string, string> }) => Promise<Placer> | Placer };
  placer = await mod.default({ log, args: Object.fromEntries((values["placer-arg"] ?? []).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)])) });
}

const server = createDemoServer({
  disk,
  region,
  control: diskControl,
  ...(diskControl ? { readObject: (key: string) => diskControl.getObject(key) } : {}),
  ...(values["tab-writable"] ? { tabWritable: values["tab-writable"].split(",").filter(Boolean) } : {}),
  ...(values["evidence-readback"] && diskControl
    ? {
        evidenceReadback: {
          list: (prefix: string) => diskControl.listAll(prefix),
          get: (key: string) => diskControl.getObject(key),
        },
      }
    : {}),
  mountRoot: values.local ?? values["mount-root"]!,
  model,
  pageDir: join(here, "tab", "dist"),
  // `--show-dir`: the stage's built files under /show/ on this origin (with the page's isolation headers), so the stage and the agent's tab share one origin and a window.open'd tab can be messaged;
  // the checkout caches what /show/offline.json lists (tab/offline.ts)
  // `--models-dir`: the local brain's files under /models/, the paths the page loads them from (?phone=1, and the laptop's page taken offline), with the same headers
  staticRoots: { "/wasmer/": join(here, "node_modules", "@wasmer", "sdk"), ...(values["show-dir"] ? { "/show/": resolvePath(values["show-dir"]) } : {}), ...(creatureDir ? { "/tab/": creatureDir } : {}), ...(values["models-dir"] ? { "/models/": resolvePath(values["models-dir"]) } : {}) },
  lease: { heartbeatMs: 2_000, expiryMs: 10_000, marginMs: 3_000 },
  writerGraceMs: Number(values["grace-ms"]),
  ...(values["remote-start-ms"] !== undefined ? { remoteStartMs: Number(values["remote-start-ms"]) } : {}),
  ...(values["writer-return-ms"] !== undefined ? { writerReturnMs: Number(values["writer-return-ms"]) } : {}),
  log,
  ...(ledger ? { ledger } : {}),
  ...(cloud ? { cloud } : {}),
  ...(placer ? { placer } : {}),
  ...(values["no-restore"]?.length ? { noRestore: values["no-restore"] } : {}),
  ...(appPolicy ? { app: appPolicy } : {}),
  ...(adminToken ? { adminToken } : {}),
  ...(judge ? { judge } : {}),
  ...(brainJudge ? { brainJudge } : {}),
  ...(values.local ? { acquire: async (opts) => localClaim(values.local!, opts), claimDir: (dir: string) => openClaimDir(dir, { fstype: null }) } : {}),
});
const port = await server.listen(Number(values.port), values.host);
const also = values["also-host"]
  ? createHttpServer((req, res) => server.http.emit("request", req, res)).on("upgrade", (req, socket, head) => server.http.emit("upgrade", req, socket, head))
  : undefined;
if (also) await new Promise<void>((resolve) => also.listen(port, values["also-host"], () => resolve()));
const { id, secret } = await server.createRun(values.run);
const base = values["public-url"]?.replace(/\/+$/, "") ?? `http://${values.host === "0.0.0.0" ? "localhost" : values.host}:${port}`;
log("ready", { url: `${base}/run/${id}#${secret}`, local: `http://127.0.0.1:${port}/run/${id}#${secret}`, run: id });

let closing = false;
const stop = async (code = 0) => {
  if (closing) return;
  closing = true;
  // Cleanup and exit always run: nothing here may throw before them (a log line is already safe, and the close is guarded as well, so a failure is a non-zero exit, not a server that stays up).
  try {
    log("stopping");
    also?.closeAllConnections();
    also?.close();
  } catch {
    code ||= 1;
  }
  // Always closed, whatever code the stop was asked for (a crash must not skip it).
  let closed = 1;
  try {
    closed = await closeServerAndCloud(server, cloud, log);
  } catch {
    closed = 1;
  }
  code ||= closed;
  try {
    log("stopped", { openLedgerRows: ledger?.openRows().length ?? null });
  } catch {
    /* the exit below is what matters */
  }
  process.exit(code);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
// A crash is not a reason to leave a warm GPU box running: clean up first. (SIGKILL cannot; the sandbox's own timeout is then the backstop.)
process.on("uncaughtException", (error) => {
  if (closing) return; // already stopping: another error on the way down is not logged again, which is how a failing log line once looped for ever
  log("uncaught", { error: error.message });
  void stop(1);
});
process.on("unhandledRejection", (reason) => {
  if (closing) return;
  log("unhandled-rejection", { error: reason instanceof Error ? reason.message : String(reason) });
  void stop(1);
});
// A harness that starts this server names its own pid: when that process is gone the server stops (a harness that is killed cannot run its own cleanup, and a server nobody reads from or stops is a leak).
if (values["parent-pid"]) {
  const parent = Number(values["parent-pid"]);
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        log("parent-gone", { pid: parent });
        void stop();
      }
    }
  }, 3000).unref();
}
