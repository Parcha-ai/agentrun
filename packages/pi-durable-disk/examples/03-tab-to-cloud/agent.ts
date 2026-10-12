// The agent, defined once for every place it runs: the browser tab (its tools on Wasmer, its store behind the pipe)
// and the cloud host (`pi-durable-disk run --app cloud-app.ts`, its tools on the claimed mount). Both install the same
// extensions under the same names, so tasks recovered on one side resume on the other, and both call the model through
// the same OpenAI-compatible provider; only where its requests go differs. Portable: no Node API.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { AgentChange, Extension, HarnessSettings, Registry, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { Context } from "@earendil-works/chord";
import { computerTool, type ComputerDriver } from "./computer-tool.ts";
import { offlineTools, type OfflineChannel } from "./offline-tools.ts";
import { switchEnvironment, type SwitchChannel } from "./switch-tool.ts";

export const PROVIDER = "pipe";

/** Model calls retry a few times with backoff, durably (pi's generation retry). */
export const SETTINGS: HarnessSettings = {
  retry: { enabled: true, maxRetries: 4, baseDelayMs: 1_000 },
};

export const INSTRUCTIONS = `You are a coding agent with your own small computer: a shell (bash with coreutils, node and npm), and a workspace directory that is your current directory.
Your computer can move while you work: from a browser tab to a cloud machine and back. You do not live in the browser: you run on whichever machine you are on now, and your home is your run's cloud disk, which your user's server holds. Never say you live in the browser; say where you are running. Your memory (this conversation) and your workspace files move with you; programs that were running do not.
Use relative paths for files in your workspace, never absolute ones. Prefer small steps: write a file, then run it.
Your user draws in the page next to this chat, and the drawing is saved to your run's disk: a creature they drew is in creature/ (creature.xml, body.json) on the machines you move to, though this tab's own workspace may not show it yet. "Teach it to walk" means training a walking policy for that creature, which needs a GPU machine: move there at once, do not ask what they mean, and do not look for the files here first.
When you finish a request, say in one or two sentences what you did and which files changed.
When what you were asked needs more than this machine has (a GPU, many cores, a desktop), move yourself where it exists with switch_environment, follow the instructions in the notice you get on arrival, and come back when the work is done.
The person watches your chat while you work, so talk to them in short plain sentences: one line before you move saying where you are going and why, one on arrival saying what you are doing, one back home saying the result. Never mention file names, paths, command lines or jargon to them: say what happened to their creature.`;

/** pi's coding tools with `read` declared replay-safe, under pi's extension name (as the package's ArchilCodingTools). */
export function codingTools(): Extension {
  return defineExtension({
    name: CodingTools.name,
    tools: (CodingTools.tools ?? []).map((tool: ToolRegistration) => (tool.name === "read" ? { ...tool, replay: "safe" as const } : tool)),
  });
}

export const WRITING_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * The rule that a tool's workspace changes are durable before its result commits, as one extension both sides install.
 * `durable` is the host's: in the tab, send the changed files to the pipe and wait for its sync; on a host with the
 * mount, the claim's barrier. pi ignores a hook that throws, so a failure turns the result into an error result.
 */
export function writeThrough(durable: (context: Context) => Promise<void>): Extension {
  return defineExtension({
    name: "workspace-write-through",
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result, _api, context) => {
          if (!WRITING_TOOLS.has(call.name)) return undefined;
          try {
            await durable(context);
            return undefined;
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            return notDurable(result, error);
          }
        },
      }),
    ],
  });
}

function notDurable(result: ToolExecutionResult, error: unknown): ToolExecutionResult {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ...result,
    isError: true,
    diagnostics: [...(result.diagnostics ?? []), { severity: "error", code: "workspace_not_durable", message: `The workspace could not be made durable: ${reason}` }],
  };
}

export interface ModelAccess {
  /** The OpenAI-compatible endpoint (`.../v1`, Responses API). In the tab it is never reached: `fetch` goes to the pipe. */
  readonly baseUrl: string;
  readonly modelId: string;
  /** A replacement for the provider's HTTP fetch (the tab's pipe). */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The credential sent as `Authorization: Bearer`. Default a placeholder: the pipe or a proxy holds the real one (a
   * sandbox's secrets proxy replaces its own placeholder on the way out).
   */
  readonly apiKey?: string;
}

/**
 * pi-ai's models with one OpenAI-compatible provider whose requests go where `access` says. It speaks the Responses
 * API: the model endpoint refuses function tools together with a reasoning effort on chat completions, and thinking is
 * never off.
 */
export function agentModels(access: ModelAccess) {
  const api = openAIResponsesApi();
  const withFetch = <T extends object | undefined>(options: T): T => (access.fetch ? ({ ...(options ?? {}), fetch: access.fetch } as T) : options);
  const provider = createProvider({
    id: PROVIDER,
    name: "Model proxy",
    baseUrl: access.baseUrl,
    auth: { apiKey: { name: "model access", resolve: async () => ({ auth: { apiKey: access.apiKey ?? "proxy" } }) } },
    models: [
      {
        id: access.modelId,
        name: access.modelId,
        api: "openai-responses",
        provider: PROVIDER,
        baseUrl: access.baseUrl,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 16_000,
      },
    ],
    api: {
      stream: (model, context, options) => api.stream(model, context, withFetch(options)),
      streamSimple: (model, context, options) => api.streamSimple(model, context, withFetch(options)),
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return models;
}

/** The root conversation's agent: the model, thinking on (never off), the instructions. */
export function rootAgent(modelId: string): AgentChange {
  return { model: { provider: PROVIDER, modelId }, thinkingLevel: "low", instructions: INSTRUCTIONS };
}

/** The root conversation's agent as it is when it comes back to the cloud model from another (a check-in): the same as `rootAgent`, and every tool the registry has again (`tools: null` clears the filter an earlier model was configured with). */
export function cloudAgent(modelId: string): AgentChange {
  return { ...rootAgent(modelId), tools: null };
}

/** What a host can offer the agent beyond the shared tools; a tool the host cannot serve is still registered, and refuses. */
export interface HostTools {
  /** How this host asks the server to move the run (the pipe of a tab or a remote host, the link of a cloud host). */
  readonly switchChannel?: SwitchChannel;
  /** How this host's page takes the run offline and back (the tab that runs the agent); anywhere else go_offline and go_online refuse. */
  readonly offlineChannel?: OfflineChannel;
  /** The environment ids this host knows, for the move tool's description. */
  readonly environments?: readonly string[];
  /** A desktop this host runs, for the computer tool. */
  readonly computer?: ComputerDriver;
  /** False: the agent is not offered switch_environment (the server places the run). Every host of one run must agree, so it comes from the server's attach frame. Default true. */
  readonly switchTool?: boolean;
}

/**
 * The registry every host installs, in the same order, with the same tool names: pi resolves a task against the registry
 * where it runs, so a run that moves mid-call must find the definition of the tool it was in wherever it resumes. A tool
 * the host cannot serve (no channel to the server, no desktop) refuses when called.
 */
export function agentRegistry(durable: (context: Context) => Promise<void>, host: HostTools = {}): Registry {
  const registry = createRegistry();
  registry.install(codingTools());
  registry.install(writeThrough(durable));
  if (host.switchTool !== false) registry.install(switchEnvironment(host.switchChannel, host.environments));
  registry.install(offlineTools(host.offlineChannel));
  registry.install(computerTool(host.computer));
  return registry;
}
