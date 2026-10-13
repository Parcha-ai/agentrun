// The measured run, the scripted take: the pi session runs on a Modal VM that mounts the run's Archil disk (e2e/vm-host.ts,
// e2e/vm-app.ts), its store and workspace on that disk; the pipeline's tools and the edited model are on the GG box, reached
// only through its guard's typed routes.
//   with-modal -- with-typesafe -- with-openai -- with-archil -- node e2e/run.ts [--box] [--keep] [--keep-run] [--out DIR]
//   --box   reuse the box in GG_STATE instead of creating one; a reused box is the caller's and is left running
//   --keep      leave the GG box this run created running
//   --keep-run  leave the VM's run tree on the Archil disk
//   --view      stage (default: one readable line per event, the edited model's thinking as the guard releases it) or json
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModalClient } from "modal";
import { followEvents, requireDone } from "./lifecycle.ts";
import { createStageView } from "./stage-view.ts";
import { readKey, startVmSession } from "./vm-host.ts";

const HERE = new URL(".", import.meta.url).pathname;
const BOX_PY = join(HERE, "..", "modal", "box.py");
const VM_DEADLINE_MS = 30 * 60_000;
const { values } = parseArgs({
  options: {
    "keep-run": { type: "boolean", default: false },
    box: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    out: { type: "string", default: join(process.cwd(), `gg-run-${new Date().toISOString().replace(/[:.]/g, "-")}`) },
    view: { type: "string", default: "stage" },
  },
});
const OUT = values.out!;
mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const stage = values.view === "json" ? undefined : createStageView((line) => console.log(line), { color: process.stdout.isTTY, width: process.stdout.columns ? Math.max(60, process.stdout.columns - 19) : 200 });
const log = (event: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ t: Math.round((Date.now() - T0) / 100) / 10, event, ...data });
  if (stage) stage(event, data, (Date.now() - T0) / 1000);
  else console.log(line);
  appendFileSync(join(OUT, "timeline.jsonl"), line + "\n");
};

function py(args: string[]): void {
  const r = spawnSync("python3", [BOX_PY, ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`box.py ${args.join(" ")} exited ${r.status}`);
}

async function main() {
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
    const box = JSON.parse(readFileSync(join(stateDir, "box.json"), "utf8")) as { sandbox: string; url: string; key_file: string; exec_key_file: string };
    const sandbox = await new ModalClient().sandboxes.fromId(box.sandbox);
    const shell = async (cmd: string): Promise<string> => {
      const p = await sandbox.exec(["bash", "-lc", cmd], { mode: "text", timeoutMs: 120_000 });
      const out = await p.stdout.readText();
      await p.wait();
      return out;
    };
    try {
      {
        const vm = await startVmSession({ keys: { "guard-url": box.url, "serve-key": readKey(box.key_file), "tools-key": readKey(box.exec_key_file), "openai-key": process.env.OPENAI_API_KEY ?? "" }, log });
        let ended: string | undefined;
        try {
          const followed = await followEvents(() => vm.shell("cat /var/tmp/gg-vm/events.jsonl 2>/dev/null || true"), log, { deadlineMs: VM_DEADLINE_MS, pollMs: 1_000 });
          ended = followed.ended;
          const out = followed.out;
          if (out) {
            const tar = await vm.shell(`cd ${out} && tar -c . | base64 -w0`, 300);
            mkdirSync(join(OUT, "vm-run"), { recursive: true });
            writeFileSync(join(OUT, "vm-run", "run.tar.b64"), tar.trim());
            spawnSync("bash", ["-c", "base64 -d run.tar.b64 | tar -x && rm run.tar.b64"], { cwd: join(OUT, "vm-run") });
            log("vm.evidence", { from: out, mount: (await vm.shell(`findmnt -no SOURCE,FSTYPE,TARGET -T ${out} || true`)).trim(), store: (await vm.shell(`ls -la ${out}/../../store 2>/dev/null | head -5 || true`)).trim() });
          }
        } finally {
          await vm.close(values["keep-run"]!);
        }
        const run = await shell("cd /var/tmp/gg/run && tar -c find.json pick.json strength.json served.json checkpoint/GOLDEN-GATE.json 2>/dev/null | base64 -w0");
        writeFileSync(join(OUT, "run.tar.b64"), run.trim());
        spawnSync("bash", ["-c", "base64 -d run.tar.b64 | tar -x && rm run.tar.b64"], { cwd: OUT });
        // after the evidence and the cleanup: a run that failed or never finished is not a result
        requireDone(ended, VM_DEADLINE_MS);
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
