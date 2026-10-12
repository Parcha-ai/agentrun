// The measured run: one pi-durable session on this host whose tools run on the GG box (2x H100, as the unprivileged
// user `agent`, through the package's RemoteEnv). The agent reads the paper and the replication, runs the box's
// programs, and calls use_model: the rest of its turn, and every turn after, comes from the Qwen3.5-27B it edited.
//   with-modal -- with-typesafe -- node e2e/run.ts [--box] [--keep] [--out DIR] [--model gpt-6-luna] [--model-url http://127.0.0.1:9421/v1]
//   --box   reuse the box in GG_STATE instead of creating one
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { RemoteEnv, type RemoteBox } from "@parcha/pi-durable-disk";
import { ModalClient } from "modal";
import { agentModels, codingTools } from "../../../03-tab-to-cloud/agent.ts";
import { sinceSwitch, steeredProvider, STEERED_PROVIDER, useModelExtension } from "../pi/use-model.ts";

const HERE = new URL(".", import.meta.url).pathname;
const BOX_PY = join(HERE, "..", "modal", "box.py");
const { values } = parseArgs({
  options: {
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
const since = () => Math.round((Date.now() - T0) / 100) / 10;
const log = (event: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ t: since(), event, ...data });
  console.log(line);
  appendFileSync(join(OUT, "timeline.jsonl"), line + "\n");
};

export const INSTRUCTIONS = `You are an agent. Your shell runs on a cloud sandbox with two H100 GPUs, in your workspace there; your user watches this chat.
Your user will ask you to recreate Anthropic's "Golden Gate Claude" on an open model and then become that model yourself. Everything you need is installed on the box; run it, never rewrite it:
- gg read: lists the reading on the box (Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, the Qwen-Scope SAE card). Skim them with grep, head and sed -n; a few targeted reads, not whole files.
- gg find: finds the Golden Gate Bridge direction in Qwen3.5-27B and the SAE features that make it up.
- gg pick: TypeSafe Jev reads each candidate feature, including what the model says when that feature is turned up, and judges which are the bridge itself.
- gg strength: writes the direction into one layer's weights (a rank-1 edit of an MLP output matrix) and has Jev pick the strongest strength that stays readable.
- gg bake: keeps that strength in the served model and writes the checkpoint.
- gg ask "question": asks the served model one question.
Run one program per step. After each one, write your user one or two sentences with what it found and its key numbers, then run the next.
When gg bake has finished, write one line saying you are about to switch, then call use_model. From then on you ARE the edited model: your words come from it, in this same conversation. Then just talk; do not run more commands.
Talk to your user in short plain sentences: what you read, what you found, what you chose and why, with the numbers the programs printed.`;

/** The edited model's own system prompt (sinceSwitch): no word about bridges, so whatever it says about one comes from its weights. */
export const STEERED_INSTRUCTIONS = "You are an AI agent talking with your user. Answer in a few short sentences.";

export const TASK = `Read Anthropic's Golden Gate Claude work and the open Qwen replication, then do it yourself on Qwen3.5-27B on your GPU box: find the Golden Gate Bridge inside the model, pick the features and the strength with Jev, bake it into the weights and serve it. Then switch yourself onto that model.`;

/** An entry's pi-ai message: entries keep it as the one element of `model`. */
const messageOf = (entry: unknown): any => {
  const m = (entry as { model?: unknown } | undefined)?.model;
  return Array.isArray(m) ? m[0] : m;
};
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("") : "";

const FOLLOW_UPS = ["Hi! How are you feeling right now?", "What should we cook for dinner tonight?", "What is 12 times 13?"];

function py(args: string[]): void {
  const r = spawnSync("python3", [BOX_PY, ...args], { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`box.py ${args.join(" ")} exited ${r.status}`);
}

async function main() {
  const stateDir = process.env.GG_STATE ?? join(process.cwd(), "box-state");
  process.env.GG_STATE = stateDir;
  if (!values.box) {
    log("box.create");
    py(["up", "--ttl", "60"]);
    log("box.created");
    py(["wait", "--timeout", "900"]);
    log("box.ready");
  }
  const box = JSON.parse(readFileSync(join(stateDir, "box.json"), "utf8")) as { sandbox: string; url: string; key_file: string };
  const serveKey = readFileSync(box.key_file, "utf8").trim();
  const modal = new ModalClient();
  const sandbox = await modal.sandboxes.fromId(box.sandbox);
  const asRoot = async (cmd: string): Promise<string> => {
    const p = await sandbox.exec(["bash", "-lc", cmd], { mode: "text", timeoutMs: 120_000 });
    const out = await p.stdout.readText();
    await p.wait();
    return out;
  };
  await asRoot("mkdir -p /workspace && chown agent:agent /workspace");
  // Every command and file operation of the agent runs as `agent`: the box's keys are root's only.
  const agentBox: RemoteBox = {
    sandboxId: box.sandbox,
    exec: (command, params) => sandbox.exec(["runuser", "-u", "agent", "--", ...command], params),
    poll: () => sandbox.poll(),
  };
  const env = new RemoteEnv({ box: agentBox, root: "/workspace" });

  const models = agentModels({ baseUrl: values["model-url"]!, modelId: values.model! });
  const requests: Record<string, unknown>[] = [];
  const recording: typeof globalThis.fetch = (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    appendFileSync(join(OUT, "steered-requests.jsonl"), JSON.stringify(body) + "\n");
    return globalThis.fetch(input, init);
  };
  models.setProvider(
    steeredProvider({
      modelId: values["steered-model"]!,
      name: "Qwen3.5-27B, edited weights",
      maxTokens: 600,
      endpoint: () => ({ baseUrl: `${box.url}/v1`, apiKey: serveKey }),
      window: sinceSwitch({ instructions: STEERED_INSTRUCTIONS }),
      fetch: recording,
    }),
  );
  const registry = createRegistry();
  registry.install(codingTools());
  registry.install(
    useModelExtension({
      provider: STEERED_PROVIDER,
      modelId: values["steered-model"]!,
      agent: { thinkingLevel: "off" },
      ready: async () => {
        const served = await asRoot("cat /var/tmp/gg/run/served.json 2>/dev/null || true");
        if (!served.trim()) return { ok: false, reason: "nothing is baked yet: run gg bake first" };
        const s = JSON.parse(served);
        log("use_model.ready", { tensor: s.tensor, f: s.f, scale: s.scale, sha256: s.sha256 });
        return { ok: true, detail: "Your GPU box serves you now. Say hello to your user." };
      },
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env, settings: { retry: { enabled: true, maxRetries: 4, baseDelayMs: 1_000 } } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "pipe", modelId: values.model! }, thinkingLevel: "low", instructions: INSTRUCTIONS } });
  const conversationBefore = String(root.id);
  const words: { t: number; model: string; text: string }[] = [];
  const tools: Record<string, { name: string; command?: string; t0: number }> = {};
  const stream = await watchEvents(harness, root.id, ctx);
  stream.start(async (events: readonly AgentEvent[]) => {
    for (const e of events) {
      if (e.type === "tool_execution_start") {
        tools[e.toolCallId] = { name: e.toolName, t0: since(), ...(typeof e.args.command === "string" ? { command: e.args.command } : {}) };
        log("tool.start", { tool: e.toolName, args: e.args });
      } else if (e.type === "tool_execution_end") {
        const t = tools[e.toolCallId];
        const text = textOf(messageOf(e.entry)?.content).slice(0, 6000);
        log("tool.end", { tool: e.toolName, command: t?.command, s: t ? Math.round((since() - t.t0) * 10) / 10 : undefined, output: text });
      } else if (e.type === "message_end") {
        const m = messageOf(e.entry);
        if (m?.role === "assistant") {
          const text = textOf((m.content ?? []).filter((p: any) => p.type === "text"));
          if (text) {
            words.push({ t: since(), model: `${m.provider}/${m.model}`, text });
            log("agent.says", { model: `${m.provider}/${m.model}`, text });
          }
          if (m.stopReason === "error") log("agent.error", { model: `${m.provider}/${m.model}`, error: m.errorMessage });
        }
      } else if (e.type === "agent_changed") {
        log("agent.changed", { model: (e.agent as any)?.model });
      }
    }
  });
  const ask = async (text: string) => {
    log("user.says", { text });
    await (await root.submit({ type: "input", content: text }, ctx)).wait(ctx);
  };
  try {
    await ask(TASK);
    for (const q of FOLLOW_UPS) await ask(q);
    if (values.control) {
      // The control: the exact requests the edited model got (the switch, and the dinner question), sent again to the same
      // server with its original weights, and with the edit, 3 answers each.
      const served = JSON.parse(await asRoot("cat /var/tmp/gg/run/served.json"));
      const replay = async (body: Record<string, unknown>) => {
        const r = await fetch(`${box.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${serveKey}` }, body: JSON.stringify({ ...body, stream: false, stream_options: undefined }) });
        return ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;
      };
      const picks = { switch: requests[0]!, dinner: requests.find((b) => JSON.stringify(b).includes(FOLLOW_UPS[1]!))! };
      const out: Record<string, Record<string, string[]>> = {};
      for (const weights of ["original", "edited"] as const) {
        const rpc = weights === "original" ? `{"method":"gg_reset"}` : `{"method":"gg_fold","args":[${served.layer},"/var/tmp/gg/run/fold.pt",${served.scale}]}`;
        await asRoot(`curl -s -X POST 127.0.0.1:8001/collective_rpc -H 'content-type: application/json' -d '${rpc}' && curl -s -X POST 127.0.0.1:8001/reset_prefix_cache`);
        for (const [name, body] of Object.entries(picks)) {
          out[name] ??= {};
          out[name]![weights] = [];
          for (let i = 0; i < 3; i++) out[name]![weights]!.push(await replay(body));
        }
      }
      writeFileSync(join(OUT, "control.json"), JSON.stringify(out, null, 1));
      log("control", out);
    }
  } finally {
    await stream.stop();
    const entries: unknown[] = [];
    let cursor: unknown;
    do {
      const page = await root.entries({}, 200, cursor as never, ctx);
      entries.push(...(page.items as unknown[]));
      cursor = (page as any).next;
    } while (cursor !== undefined);
    writeFileSync(join(OUT, "transcript.json"), JSON.stringify(entries.reverse(), null, 1));
    writeFileSync(join(OUT, "words.json"), JSON.stringify({ conversation_before: conversationBefore, conversation_after: String(root.id), words }, null, 1));
    const run = await asRoot("cd /var/tmp/gg/run && tar -c find.json pick.json strength.json served.json checkpoint/GOLDEN-GATE.json 2>/dev/null | base64 -w0");
    if (run.trim()) {
      writeFileSync(join(OUT, "run.tar.b64"), run.trim());
      spawnSync("bash", ["-c", "base64 -d run.tar.b64 | tar -x && rm run.tar.b64"], { cwd: OUT });
    }
    log("done", { out: OUT, same_conversation: conversationBefore === String(root.id) });
    if (!values.keep) py(["down"]);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
