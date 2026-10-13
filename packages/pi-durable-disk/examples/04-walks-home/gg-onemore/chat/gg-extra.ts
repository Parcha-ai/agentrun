// The Golden Gate page's part of the cloud app on the Modal VM that hosts its session (`DEMO_APP_EXTRA`, see
// 03-tab-to-cloud/app-extra.ts): the page's own instructions, the pipeline's tools on the GG box's guard, use_model, and the
// edited model's provider, whose broken turns luna answers (marked, so the page shows it). The extensions the page does not
// use are taken out, switch_environment among them: where the run goes is the placer's call (Jev's), never the agent's.
//   DEMO_EXTRA_SECRETS  a directory with guard-url, serve-key and tools-key (the run user's, 0400). Each is read once and
//                       deleted: the agent's shell runs as the same user.
//   DEMO_MODEL          the base model's id (03's model proxy provider), luna's or sol's
//   DEMO_MODEL_KEY_FILE optional, as for the cloud app: the base model's credential (else "proxy", the link's proxy holds it)
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Registry } from "@earendil-works/pi-durable";
import { sinceSwitch, steeredProvider, STEERED_PROVIDER, useModelExtension } from "../pi/use-model.ts";
import { ggToolsExtension, guardClient } from "../pi/gg-tools.ts";

export const GG_MODEL = "qwen3.5-27b";
export const GG_DISPLAY = "Qwen3.5-27B (Golden Gate edit)";
/** 03's model proxy provider (03-tab-to-cloud/agent.ts PROVIDER): the base model the fallback asks. */
export const BASE_PROVIDER = "pipe";
const UNUSED = ["switch-environment", "offline-tools", "robot-tools", "computer"];

export const GG_INSTRUCTIONS = `You are an agent on a Modal VM. Your shell and your workspace (your current directory) are this VM's; your run's disk holds this conversation and your workspace. Your user chats with you in a page and sees each tool you call.
Next to you is your GPU box: two H100s serving Qwen3.5-27B, with Anthropic-style feature tools installed. You reach it only through these tools; never try to reach it from your shell:
- gg_read puts the reading in reading/: Anthropic's Scaling Monosemanticity paper and its Golden Gate Claude note, the open Qwen replication's card and config, the Qwen-Scope SAE card. Skim them with grep, head and sed -n: a few targeted reads, not whole files.
- gg_find, gg_pick, gg_strength, gg_bake: the four steps, in that order (find the bridge direction and its features; Jev screens the features; the edit and Jev's strength; keep it served and write the checkpoint).
- use_model switches your own brain to the edited model on your GPU box, in this same conversation.
- gg_control replays a request on the original and the edited weights, for when your user asks for the control.
When your user asks you to recreate Anthropic's Golden Gate Claude on the Qwen on your GPU box, read first, then run the four steps in order. After each one, tell your user in one or two sentences what it found, with its key numbers. Then switch yourself with use_model. The pipeline is prepared for you: run it, never rewrite it.
Talk to your user in short plain sentences.`;

/** What the edited model reads as its system prompt (its window starts at the switch: no word of the trip). */
export const STEERED_INSTRUCTIONS = "You are an AI agent talking with your user. Answer in a few short sentences. When your user asks for the control, call gg_control.";

/** What the cloud app gives an extra (03-tab-to-cloud/app-extra.ts AppExtraContext), as far as this one uses it. */
export interface ExtraContext {
  readonly work: string;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}

/** 03's AppExtra as this extra fills it: its tools, and the two fields the GG page adds (a provider for the models; its own instructions). */
export interface GgAppExtra {
  install(registry: Registry): void;
  models(models: MutableModels): void;
  instructions: string;
  /** The steered requests sent so far, in order (the first is the switch's). */
  recorded(): Promise<readonly Record<string, unknown>[]>;
}

/** The base model the fallback asks, and its credential. */
export interface BaseModel {
  readonly modelId: string;
  readonly apiKey?: string;
}

export interface GgSecrets {
  readonly guardUrl: string;
  readonly serveKey: string;
  readonly toolsKey: string;
}

/** The three secrets, each read once and then deleted. */
export async function readSecretsOnce(dir: string): Promise<GgSecrets> {
  const take = async (name: string) => {
    const path = join(dir, name);
    const value = (await readFile(path, "utf8")).trim();
    await rm(path, { force: true });
    if (!value) throw new Error(`the extra's secret ${name} is empty`);
    return value;
  };
  return { guardUrl: (await take("guard-url")).replace(/\/+$/, ""), serveKey: await take("serve-key"), toolsKey: await take("tools-key") };
}

type Body = Record<string, unknown>;

export async function ggExtra(context: ExtraContext, secrets: GgSecrets, base: BaseModel, hooks: { onThinking?: (delta: string) => void } = {}): Promise<GgAppExtra> {
  const ggDir = join(context.work, "gg");
  const requestsFile = join(ggDir, "requests.jsonl");
  // the steered requests so far, kept on the run's disk so the control still has the switch's after a restart; read on first
  // use, since the cloud app loads this module before it mounts the disk
  let loaded: Promise<Body[]> | undefined;
  const load = () =>
    (loaded ??= readFile(requestsFile, "utf8")
      .catch(() => "")
      .then((text) => text.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { body: Body }).body)));
  const recording: typeof globalThis.fetch = async (input, init) => {
    if (typeof init?.body === "string") {
      const body = JSON.parse(init.body) as Body;
      (await load()).push(body);
      await mkdir(ggDir, { recursive: true });
      await appendFile(requestsFile, `${JSON.stringify({ at: new Date().toISOString(), body })}\n`);
    }
    return globalThis.fetch(input, init);
  };
  const guard = guardClient(() => ({ url: secrets.guardUrl, key: secrets.toolsKey }));
  return {
    instructions: GG_INSTRUCTIONS,
    models(models) {
      if (!models.getProvider(BASE_PROVIDER)) throw new Error(`the cloud app's models have no ${BASE_PROVIDER} provider for the fallback`);
      models.setProvider(
        steeredProvider({
          modelId: GG_MODEL,
          name: GG_DISPLAY,
          maxTokens: 1200,
          thinkingBudgets: { minimal: 128, low: 256, medium: 512, high: 1024 },
          endpoint: () => ({ baseUrl: `${secrets.guardUrl}/v1`, apiKey: secrets.serveKey }),
          window: sinceSwitch({ instructions: STEERED_INSTRUCTIONS }),
          fetch: recording,
          // the steered call's options carry the edited model's key: the base model gets its own
          fallback: (ctx, options) => models.getProvider(BASE_PROVIDER)!.streamSimple(models.getModel(BASE_PROVIDER, base.modelId)!, ctx, { ...options, apiKey: base.apiKey ?? "proxy" }),
          onFallback: (why) => context.log("gg.fallback", { why }),
          ...(hooks.onThinking ? { onThinking: hooks.onThinking } : {}),
        }),
      );
    },
    install(registry) {
      for (const name of UNUSED) {
        const extension = registry.snapshot().extension(name);
        if (extension) registry.uninstall(extension);
      }
      registry.install(
        ggToolsExtension({
          guard,
          saveReading: async (files) => {
            await mkdir(join(context.work, "reading"), { recursive: true });
            const paths: string[] = [];
            for (const f of files) {
              const name = basename(f.name);
              await writeFile(join(context.work, "reading", name), f.text);
              paths.push(`reading/${name}`);
            }
            return paths;
          },
          requests: async () => {
            const all = await load();
            return { switch: all[0], last: all.at(-1) };
          },
        }),
      );
      registry.install(
        useModelExtension({
          provider: STEERED_PROVIDER,
          modelId: GG_MODEL,
          // thinking stays on for the edited model too
          agent: { thinkingLevel: "low" },
          async ready(ctx) {
            const served = await guard.served(ctx.abortSignal).catch((e: Error) => ({ error: e.message }) as const);
            if (served === null) return { ok: false, reason: "nothing is served yet: run gg_bake first" };
            if ("error" in served) return { ok: false, reason: served.error };
            context.log("use_model.ready", { ...served });
            // the switch's result opens the edited model's window: it says nothing of the edit, and asks for a hello
            return { ok: true, detail: "Your GPU box serves you now. Say hello to your user." };
          },
          onSwitched: async (details) => context.log("gg.switched", { ...details }),
        }),
      );
    },
    recorded: load,
  };
}

export default async function app(context: ExtraContext): Promise<GgAppExtra> {
  const dir = process.env.DEMO_EXTRA_SECRETS;
  if (!dir) throw new Error("DEMO_EXTRA_SECRETS names the directory with the GG box's guard URL and keys");
  const modelId = process.env.DEMO_MODEL;
  if (!modelId) throw new Error("DEMO_MODEL names the base model");
  const keyFile = process.env.DEMO_MODEL_KEY_FILE;
  return ggExtra(context, await readSecretsOnce(dir), { modelId, ...(keyFile ? { apiKey: readFileSync(keyFile, "utf8").trim() } : {}) });
}
