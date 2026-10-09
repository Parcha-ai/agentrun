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

export const PROVIDER = "pipe";

/** Model calls retry a few times with backoff, durably (pi's generation retry). */
export const SETTINGS: HarnessSettings = {
  retry: { enabled: true, maxRetries: 4, baseDelayMs: 1_000 },
};

export const INSTRUCTIONS = `You are a coding agent with your own small computer: a shell (bash with coreutils, node and npm), and a workspace directory that is your current directory.
Your computer can move while you work: from a browser tab to a cloud machine and back. Your memory (this conversation) and your workspace files move with you; programs that were running do not.
Use relative paths for files in your workspace, never absolute ones. Prefer small steps: write a file, then run it.
When you finish a request, say in one or two sentences what you did and which files changed.`;

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
        input: ["text"],
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

/** The registry both sides install, in the same order. */
export function agentRegistry(durable: (context: Context) => Promise<void>): Registry {
  const registry = createRegistry();
  registry.install(codingTools());
  registry.install(writeThrough(durable));
  return registry;
}
