// A chat page's part of the cloud app on the Modal VM that hosts its session (`DEMO_APP_EXTRA`, see
// 03-tab-to-cloud/app-extra.ts): the page's own instructions (the Golden Gate page's, or the any-topic page's, steer-extra.ts),
// the tools on the GPU box's guard, use_model, and the edited model's provider, whose broken turns the base model answers
// (marked, so the page shows it). The header's name for the edited model is the served edit's (a recipe's `display`),
// registered at the switch. The shared extensions the page does
// not use go (`withoutExtensions`, the host drops them), switch_environment among them: where the run goes is the placer's
// call (Jev's), never the agent's.
//   DEMO_EXTRA_SECRETS  a directory with guard-url, serve-key and tools-key (the run user's, 0400). Each is read once and
//                       deleted: the agent's shell runs as the same user. A process restarted on the same VM needs them
//                       staged again by the server (README, keys).
//   DEMO_MODEL          the base model's id (03's model proxy provider), luna's or sol's
//   DEMO_MODEL_KEY_FILE optional, as for the cloud app: the base model's credential (else "proxy", the link's proxy holds it)
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Registry } from "@earendil-works/pi-durable";
import { sinceSwitch, steeredProvider, STEERED_PROVIDER, useModelExtension } from "../pi/use-model.ts";
import { GG_DISPLAY, GG_INSTRUCTIONS, GG_MODEL, GG_PAGE, GG_SWITCH_TEXT, GG_WITHOUT_ON_VM, type PageText } from "./gg-text.ts";
import { ggToolsExtension, guardClient, type Served } from "../pi/gg-tools.ts";
import thinking from "../pipeline/data/thinking.json" with { type: "json" };

const THINK_BUDGET: number = thinking.thinking_token_budget;

/** 03's model proxy provider (03-tab-to-cloud/agent.ts PROVIDER): the base model the fallback asks. */
export const BASE_PROVIDER = "pipe";

/** What the cloud app gives an extra (03-tab-to-cloud/app-extra.ts AppExtraContext), as far as this one uses it. */
export interface ExtraContext {
  readonly work: string;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
}

/** 03's AppExtra (03-tab-to-cloud/app-extra.ts) as this extra fills it: its tools, a provider for the models, its own instructions in place of the robot page's, and the shared extensions the page drops. */
export interface GgAppExtra {
  install(registry: Registry): void;
  models(models: MutableModels): void;
  instructions: { readonly mode: "replace"; readonly text: string };
  withoutExtensions: readonly string[];
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
    const value = await readFile(path, "utf8").then(
      (text) => text.trim(),
      (e: NodeJS.ErrnoException) => {
        throw new Error(
          e.code === "ENOENT" ? `the extra's secret ${name} is gone: they are read once, and a process restarted on this VM needs them staged again` : `the extra's secret ${name}: ${e.message}`,
        );
      },
    );
    await rm(path, { force: true });
    if (!value) throw new Error(`the extra's secret ${name} is empty`);
    return value;
  };
  return { guardUrl: (await take("guard-url")).replace(/\/+$/, ""), serveKey: await take("serve-key"), toolsKey: await take("tools-key") };
}

type Body = Record<string, unknown>;

/** What use_model's check tells the agent about the served edit. */
export function servedDetail(served: Served): string {
  const layers = [...new Set(served.parts.map((p) => p.layer ?? served.layer).flat())].filter((L) => L !== undefined);
  const parts = served.parts.length ? `${served.parts.length} SAE features clamped at layer ${layers.join(", ")}` : "";
  const adds = (served.adds ?? []).map((a) => `a direction added at layer ${a.layer} (f ${a.f})`).join(", ");
  return [parts, adds].filter(Boolean).join(" and ") || "the unedited model";
}

export async function ggExtra(context: ExtraContext, secrets: GgSecrets, base: BaseModel, hooks: { onThinking?: (delta: string) => void } = {}, page: PageText = GG_PAGE): Promise<GgAppExtra> {
  const ggDir = join(context.work, "gg");
  const requestsFile = join(ggDir, "requests.jsonl");
  // the steered requests so far, kept on the run's disk (the scripted take's control replays the switch's); read on first
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
  // the models the provider is registered in, and the name it has there: the switch registers the served edit's name
  let steered: { models: MutableModels; name: string } | undefined;
  const register = (models: MutableModels, name: string) => {
    steered = { models, name };
    models.setProvider(
      steeredProvider({
        modelId: GG_MODEL,
        // the page's header shows the registered name
        modelName: name,
        // the strength probes' budget at every level (pipeline/data/thinking.json); pi-ai cuts the budget to keep 1024
        // tokens for the answer under max_tokens (MIN_ANSWER_TOKENS), so max_tokens leaves exactly that room
        maxTokens: THINK_BUDGET + 1024,
        // the conversation's history is the base model's (the edited model's window starts at the switch), so it is
        // measured against the base model's context: a compaction is never summarized by the edited model
        contextWindow: models.getModel(BASE_PROVIDER, base.modelId)?.contextWindow ?? 1_000_000,
        thinkingBudgets: { minimal: THINK_BUDGET, low: THINK_BUDGET, medium: THINK_BUDGET, high: THINK_BUDGET },
        endpoint: () => ({ baseUrl: `${secrets.guardUrl}/v1`, apiKey: secrets.serveKey }),
        // the GPU server's own limit (65,536 tokens, box/start.sh) less the turn's thinking and answer, at ~3 characters a token
        // no system prompt: nothing tells the edited model who it is or what to do
        window: sinceSwitch({ maxChars: 3 * (65_536 - THINK_BUDGET - 1024 - 4096) }),
        fetch: recording,
        // the steered call's options carry the edited model's key: the base model gets its own
        fallback: (ctx, options) => models.getProvider(BASE_PROVIDER)!.streamSimple(models.getModel(BASE_PROVIDER, base.modelId)!, ctx, { ...options, apiKey: base.apiKey ?? "proxy" }),
        onFallback: (why) => context.log("gg.fallback", { why }),
        ...(hooks.onThinking ? { onThinking: hooks.onThinking } : {}),
      }),
    );
  };
  return {
    instructions: { mode: "replace", text: page.instructions },
    withoutExtensions: GG_WITHOUT_ON_VM,
    models(models) {
      if (!models.getProvider(BASE_PROVIDER)) throw new Error(`the cloud app's models have no ${BASE_PROVIDER} provider for the fallback`);
      register(models, page.display);
      // a host that opens again may resume a conversation already on the edited model, with no switch to come: its name is
      // what the box serves (no box, or nothing served: the page's own)
      void guard
        .served()
        .then((served) => {
          if (served?.display && steered?.name === page.display) register(models, served.display);
        })
        .catch(() => undefined);
    },
    install(registry) {
      const tools = ggToolsExtension({
        guard,
        mode: "skill",
        skill: page.skill,
        saveSkill: async (name, text) => {
          // the guard sends plain names; a name is one path segment here whatever it sends
          const dir = basename(name);
          await mkdir(join(context.work, "skills", dir), { recursive: true });
          await writeFile(join(context.work, "skills", dir, "SKILL.md"), text);
          return `skills/${dir}/SKILL.md`;
        },
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
      });
      registry.install(tools);
      registry.install(
        useModelExtension({
          provider: STEERED_PROVIDER,
          modelId: GG_MODEL,
          // thinking stays on for the edited model too; it is offered no tool (every tool's description speaks of the GPU
          // box or the topic, and the edited model reads no word of it)
          agent: { thinkingLevel: "low", tools: [] },
          async ready(ctx) {
            const served = await guard.served(ctx.abortSignal).catch((e: Error) => ({ error: e.message }) as const);
            if (served === null) return { ok: false, reason: "nothing is served yet: serve an edit first (gpulab.serve, or gpulab.load for a recipe)" };
            if ("error" in served) return { ok: false, reason: served.error };
            context.log("use_model.ready", { ...served });
            // the header names what is served: the switch's agent change sends the page the registry's names again
            const name = served.display ?? page.display;
            if (steered && steered.name !== name) register(steered.models, name);
            return { ok: true, detail: servedDetail(served) };
          },
          // the switch's result opens the edited model's window: a greeting to answer, no word of the edit or of who it is
          result: () => GG_SWITCH_TEXT,
          onSwitched: async (details) => context.log("gg.switched", { ...details }),
        }),
      );
    },
    recorded: load,
  };
}

/** The cloud app's extra for a page, from its environment (above). */
export function pageApp(page: PageText): (context: ExtraContext) => Promise<GgAppExtra> {
  return async (context) => {
    const dir = process.env.DEMO_EXTRA_SECRETS;
    if (!dir) throw new Error("DEMO_EXTRA_SECRETS names the directory with the GPU box's guard URL and keys");
    const modelId = process.env.DEMO_MODEL;
    if (!modelId) throw new Error("DEMO_MODEL names the base model");
    const keyFile = process.env.DEMO_MODEL_KEY_FILE;
    return ggExtra(context, await readSecretsOnce(dir), { modelId, ...(keyFile ? { apiKey: readFileSync(keyFile, "utf8").trim() } : {}) }, {}, page);
  };
}

export default pageApp(GG_PAGE);

export { GG_DISPLAY, GG_INSTRUCTIONS, GG_MODEL };
export type { PageText };
