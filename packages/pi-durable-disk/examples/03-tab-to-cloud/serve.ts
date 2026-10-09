// Start the demo: the page, the pipe, and where a run goes when its tab is gone.
//
//   node serve.ts [--port 8790] [--host 127.0.0.1] [--run ID] [--local DIR]
//                 --model ID --model-url URL [--model-key-env NAME] [--budget 400000]
//                 [--mount-root /mnt/pda/demo/pipe] [--ledger DEMO-STATE.json] [--log FILE] [--cloud none|local|daytona]
//                 [--daytona-snapshot NAME] [--daytona-gpu-snapshot NAME] [--daytona-secret NAME | --cloud-link]
//                 [--also-host ADDR] [--public-url https://HOST]
//
// --also-host listens on a second address too (a reverse proxy's side of a bridge); --public-url is the address the
// printed link uses (the proxy's). The admin route answers on loopback only.
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
import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { archilControl, jsonLog, Ledger } from "./pipe/control.ts";
import { createDemoServer, type CloudHost } from "./pipe/server.ts";
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
    "daytona-snapshot": { type: "string", default: process.env.DEMO_DAYTONA_SNAPSHOT },
    "daytona-secret": { type: "string" },
    "daytona-gpu-snapshot": { type: "string", default: process.env.DEMO_DAYTONA_GPU_SNAPSHOT },
    budget: { type: "string", default: "400000" },
    "mount-root": { type: "string", default: "/mnt/pda/demo/pipe" },
    ledger: { type: "string" },
    log: { type: "string" },
    cloud: { type: "string", default: "none" },
    "cloud-events": { type: "string" },
    "cloud-link": { type: "boolean", default: false },
    "grace-ms": { type: "string", default: "5000" },
    "admin-token-file": { type: "string" },
    "also-host": { type: "string" },
    "public-url": { type: "string" },
  },
});

const log = jsonLog(values.log);
if (!values.model || !values["model-url"]) {
  console.error("name the model: --model ID --model-url URL (an OpenAI-compatible endpoint with the Responses API), or DEMO_MODEL and DEMO_MODEL_URL");
  process.exit(2);
}
const modelKey = values["model-key-env"] ? process.env[values["model-key-env"]] : undefined;
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
  });
}

const server = createDemoServer({
  disk,
  region,
  control: values.local ? null : await archilControl({ disk, region, apiKey: process.env.ARCHIL_API_KEY ?? "" }),
  mountRoot: values.local ?? values["mount-root"]!,
  model,
  pageDir: join(here, "tab", "dist"),
  staticRoots: { "/wasmer/": join(here, "node_modules", "@wasmer", "sdk") },
  lease: { heartbeatMs: 2_000, expiryMs: 10_000, marginMs: 3_000 },
  writerGraceMs: Number(values["grace-ms"]),
  log,
  ...(ledger ? { ledger } : {}),
  ...(cloud ? { cloud } : {}),
  ...(adminToken ? { adminToken } : {}),
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
const stop = async () => {
  if (closing) return;
  closing = true;
  log("stopping");
  also?.close();
  await server.close();
  await cloud?.close?.();
  log("stopped", { openLedgerRows: ledger?.openRows().length ?? null });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
