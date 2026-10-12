// The session hosted on the GG box itself, run as root: `node /opt/gg-onemore/session.mjs --out DIR`. The keys come from
// /run/gg/session.env (root-only) into memory and never into the environment; the agent's commands run as `agent` with a
// clean environment; the store is a pi-durable SQLite file on the box's disk; luna is called at api.openai.com from here;
// the edited model is reached through the guard on localhost.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openArchilStore, RemoteEnv, type RemoteBox, type RemoteProcess } from "@parcha/pi-durable-disk";
import { runSession } from "./session.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "/var/tmp/gg/session-run" },
    store: { type: "string", default: "/var/tmp/gg/session/store.db" },
    luna: { type: "string", default: "gpt-6-luna" },
    "luna-url": { type: "string", default: "https://api.openai.com/v1" },
    "steered-url": { type: "string", default: "http://127.0.0.1:8000/v1" },
    "steered-model": { type: "string", default: "qwen3.5-27b" },
    control: { type: "boolean", default: true },
  },
});
const OUT = values.out!;
mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const log = (event: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ t: Math.round((Date.now() - T0) / 100) / 10, event, ...data });
  console.log(line);
  appendFileSync(join(OUT, "timeline.jsonl"), line + "\n");
};

function keys(): { openai: string; serve: string } {
  const found: Record<string, string> = {};
  for (const line of readFileSync("/run/gg/session.env", "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) found[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  if (!found.OPENAI_API_KEY || !found.GG_SERVE_KEY) throw new Error("/run/gg/session.env lacks OPENAI_API_KEY or GG_SERVE_KEY");
  return { openai: found.OPENAI_API_KEY, serve: found.GG_SERVE_KEY };
}

/** The agent's hands on this machine: every command as `agent`, with nothing of this process's environment. */
function agentBox(): RemoteBox {
  return {
    sandboxId: "gg-box-local",
    poll: async () => null,
    exec: async (command, params) => {
      const child = spawn("/usr/sbin/runuser", ["-u", "agent", "--", ...command], {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/agent", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = params.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), params.timeoutMs) : undefined;
      const exited = new Promise<number>((resolve) => {
        child.on("error", () => resolve(127));
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolve(code ?? 137);
        });
      });
      const proc: RemoteProcess = {
        stdin: {
          writeBytes: (bytes) => new Promise<void>((resolve, reject) => child.stdin.write(bytes, (e) => (e ? reject(e) : resolve()))),
          close: async () => void child.stdin.end(),
        },
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () => exited,
      };
      return proc;
    },
  };
}

const shell = (cmd: string) =>
  new Promise<string>((resolve, reject) => execFile("bash", ["-lc", cmd], { maxBuffer: 64 << 20 }, (e, out) => (e ? reject(e) : resolve(out))));

async function main() {
  const k = keys();
  await shell("mkdir -p /workspace && chown agent:agent /workspace");
  const store = await openArchilStore(values.store!);
  log("box.session", { store: store.file, profile: store.profile, node: process.version });
  const result = await runSession({
    env: new RemoteEnv({ box: agentBox(), root: "/workspace" }),
    storage: store.storage,
    luna: { baseUrl: values["luna-url"]!, modelId: values.luna!, apiKey: k.openai },
    steered: { baseUrl: values["steered-url"]!, apiKey: k.serve, modelId: values["steered-model"]! },
    shell,
    out: OUT,
    control: values.control!,
    log,
    where: "the GG box itself (session host, store and tools on the sandbox)",
  });
  for (const f of ["find.json", "pick.json", "strength.json", "served.json"]) if (existsSync(`/var/tmp/gg/run/${f}`)) copyFileSync(`/var/tmp/gg/run/${f}`, join(OUT, f));
  log("done", { out: OUT, same_conversation: result.sameConversation });
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
