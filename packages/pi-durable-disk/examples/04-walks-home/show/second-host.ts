// A 03 demo server for rehearsing the switch beat with no cloud: the disk is a local directory, the model is whatever
// endpoint you name (the sprint's broker), and the one cloud environment is a "second host", a child process running
// remote-host.ts. A tab switches to it and back; the stage watches the run through the pipe (SHOW_PIPE_LINK_FILE).
// serve.ts in 03 only offers --cloud local (systemd units) or daytona, so this composes createDemoServer the way
// 03/test/remote.test.ts does, as a standalone process.
//
//   node second-host.ts [--port 8791] [--model gpt-6-luna] [--model-url http://127.0.0.1:9421/v1]
//                       [--root DIR] [--link-file FILE] [--run ID]
//
// It writes the run's link (`http://127.0.0.1:PORT/run/ID#SECRET`, the secret is the run's) to --link-file with mode
// 0600 and prints only the run id and port. Open the link in a browser to attach the tab (the writer); stop with SIGTERM.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { createDemoServer, type CloudHost, type Invite } from "../../03-tab-to-cloud/pipe/server.ts";
import { localClaim } from "../../03-tab-to-cloud/test/_local.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ex03 = join(here, "..", "..", "03-tab-to-cloud");
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8791" },
    model: { type: "string", default: "gpt-6-luna" },
    "model-url": { type: "string", default: "http://127.0.0.1:9421/v1" },
    root: { type: "string", default: join(homedir(), "tmp-d5", "second-host") },
    "link-file": { type: "string" },
    run: { type: "string", default: "stage" },
  },
});
const root = values.root!;
mkdirSync(join(root, "disk"), { recursive: true, mode: 0o755 });
const linkFile = values["link-file"] ?? join(root, "link");
const tokenFile = join(root, "remote-token");
writeFileSync(tokenFile, `remote-${Math.random().toString(36).slice(2)}\n`, { mode: 0o600 });
const token = readFileSync(tokenFile, "utf8").trim();
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

let child: ChildProcess | undefined;
const cloud: CloudHost = {
  environments: [{ id: "second-host", label: "Second host", phrase: "a second machine next to your user's server", kind: "remote", detail: "a local process with its own workspace" }],
  start: async () => {
    throw new Error("the second host is a remote environment: it starts through startRemote");
  },
  stop: async () => undefined,
  async startRemote(_ref, _env, invite: Invite) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    child = spawn(process.execPath, [join(ex03, "remote-host.ts"), "--port", String(port), "--token-file", tokenFile, "--work", join(root, "remote-work")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, DEMO_ENV_LABEL: "a second machine next to your user's server", DEMO_ENV_CLASS: "second host" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    child.stdout!.on("data", (d) => out.push(String(d)));
    child.stderr!.on("data", (d) => out.push(String(d)));
    for (let i = 0; ; i++) {
      const socket = await new Promise<WebSocket | undefined>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${token}` } });
        ws.once("open", () => resolve(ws));
        ws.once("error", () => resolve(undefined));
      });
      if (socket) {
        socket.send(JSON.stringify(invite));
        log("second-host.started", { port, ms: i * 100 });
        return { socket, host: "second-host-1" };
      }
      if (i > 100) throw new Error(`the second host did not listen: ${out.join("").slice(-400)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  },
  async stopRemote() {
    child?.kill("SIGTERM");
  },
};

const server = createDemoServer({
  disk: "dsk-local",
  region: "local",
  control: null,
  mountRoot: join(root, "disk"),
  model: { baseUrl: values["model-url"]!, model: values.model!, budgetTokens: 400_000 },
  pageDir: join(ex03, "tab", "dist"),
  staticRoots: { "/wasmer/": join(ex03, "node_modules", "@wasmer", "sdk") },
  lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
  acquire: async (opts) => localClaim(join(root, "disk"), opts),
  claimDir: (dir) => openClaimDir(dir, { fstype: null }),
  cloud,
  drainMs: 10_000,
  log: (event, data = {}) => log(event, data),
});
const port = await server.listen(Number(values.port), "127.0.0.1");
const { id, secret } = await server.createRun(values.run);
writeFileSync(linkFile, `http://127.0.0.1:${port}/run/${id}#${secret}\n`, { mode: 0o600 });
log("ready", { run: id, port, linkFile });

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  child?.kill("SIGTERM");
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
