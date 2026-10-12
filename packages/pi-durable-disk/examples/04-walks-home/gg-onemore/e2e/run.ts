// The measured run. `--session box` (default): the pi session itself runs on the GG box (e2e/box-session.ts, bundled into
// the image), its store on the box's disk, luna called from the box. `--session host`: the session runs here, its tools on
// the box through the package's RemoteEnv, luna through the local broker.
//   with-modal -- with-typesafe -- with-openai -- node e2e/run.ts [--session box|host] [--box] [--keep] [--out DIR]
//   --box   reuse the box in GG_STATE instead of creating one; a reused box is the caller's and is left running
//   --keep  leave the box this run created running
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { RemoteEnv, type RemoteBox } from "@parcha/pi-durable-disk";
import { ModalClient } from "modal";
import { runSession } from "./session.ts";

const HERE = new URL(".", import.meta.url).pathname;
const BOX_PY = join(HERE, "..", "modal", "box.py");
const { values } = parseArgs({
  options: {
    session: { type: "string", default: "box" },
    box: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    out: { type: "string", default: join(process.cwd(), `gg-run-${new Date().toISOString().replace(/[:.]/g, "-")}`) },
    model: { type: "string", default: "gpt-6-luna" },
    "model-url": { type: "string", default: "http://127.0.0.1:9421/v1" },
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

function py(args: string[]): void {
  const r = spawnSync("python3", [BOX_PY, ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`box.py ${args.join(" ")} exited ${r.status}`);
}

async function main() {
  if (values.session !== "box" && values.session !== "host") throw new Error("--session is box or host");
  const stateDir = process.env.GG_STATE ?? join(process.cwd(), "box-state");
  process.env.GG_STATE = stateDir;
  // Teardown is the outermost cleanup, and only of the box this run created (a failed start included): a failed boot,
  // setup, run or artifact save never leaves its GPUs running, and a refused `up` never stops another run's box.
  const saved = () => {
    try {
      return (JSON.parse(readFileSync(join(stateDir, "box.json"), "utf8")) as { sandbox?: string }).sandbox;
    } catch {
      return undefined;
    }
  };
  let created: string | undefined;
  try {
    if (!values.box) {
      const before = saved();
      log("box.create");
      try {
        py(["up", "--ttl", "60"]);
      } finally {
        const after = saved();
        if (after && after !== before) created = after;
      }
      log("box.created", { sandbox: created });
      py(["wait", "--timeout", "900"]);
      log("box.ready");
    }
    const box = JSON.parse(readFileSync(join(stateDir, "box.json"), "utf8")) as { sandbox: string; url: string; key_file: string };
    const sandbox = await new ModalClient().sandboxes.fromId(box.sandbox);
    const shell = async (cmd: string): Promise<string> => {
      const p = await sandbox.exec(["bash", "-lc", cmd], { mode: "text", timeoutMs: 120_000 });
      const out = await p.stdout.readText();
      await p.wait();
      return out;
    };
    try {
      if (values.session === "box") {
        log("session.on_box");
        py(["exec", "--root", `node /opt/gg-onemore/session.mjs --out /var/tmp/gg/session-run${values.control ? "" : " --no-control"}`]);
        const tar = await shell("cd /var/tmp/gg/session-run && tar -c . | base64 -w0");
        writeFileSync(join(OUT, "box.tar.b64"), tar.trim());
        spawnSync("bash", ["-c", "base64 -d box.tar.b64 | tar -x && rm box.tar.b64"], { cwd: OUT });
      } else {
        await shell("mkdir -p /workspace && chown agent:agent /workspace");
        // Every command and file operation of the agent runs as `agent`: the box's keys are root's only.
        const agentBox: RemoteBox = {
          sandboxId: box.sandbox,
          exec: (command, params) => sandbox.exec(["runuser", "-u", "agent", "--", ...command], params),
          poll: () => sandbox.poll(),
        };
        await runSession({
          env: new RemoteEnv({ box: agentBox, root: "/workspace" }),
          storage: new MemoryStorage(),
          luna: { baseUrl: values["model-url"]!, modelId: values.model! },
          steered: { baseUrl: `${box.url}/v1`, apiKey: readFileSync(box.key_file, "utf8").trim(), modelId: values["steered-model"]! },
          shell,
          out: OUT,
          control: values.control!,
          log,
          where: "this host (session and store here, tools on the box)",
        });
        const run = await shell("cd /var/tmp/gg/run && tar -c find.json pick.json strength.json served.json checkpoint/GOLDEN-GATE.json 2>/dev/null | base64 -w0");
        writeFileSync(join(OUT, "run.tar.b64"), run.trim());
        spawnSync("bash", ["-c", "base64 -d run.tar.b64 | tar -x && rm run.tar.b64"], { cwd: OUT });
      }
    } finally {
      writeFileSync(join(OUT, "guard.jsonl"), await shell("cat /var/tmp/gg/guard.jsonl 2>/dev/null || true"));
    }
    log("done", { out: OUT });
  } finally {
    if (created && !values.keep) {
      try {
        py(["down", "--id", created]);
      } catch (error) {
        log("box.down_failed", { sandbox: created, error: String(error) });
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
