export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface PiModelRuntime {
  getModel(providerId: string, modelId: string): PiModel | undefined;
  getAvailableSnapshot(): readonly PiModel[];
}

export interface PiEvent {
  type: string;
  message?: { role: string; stopReason?: string; errorMessage?: string };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
}

export interface PiToolResult<TDetails = unknown> {
  content: Array<{ type: "text"; text: string; textSignature?: string } | { type: "image"; data: string; mimeType: string }>;
  details: TDetails;
}

export interface PiToolDefinition<TArgs = unknown, TDetails = unknown> {
  name: string;
  label: string;
  description: string;

  parameters: object;
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string, params: TArgs, signal: AbortSignal | undefined, onUpdate: ((result: PiToolResult<TDetails>) => void) | undefined, context: unknown): Promise<PiToolResult<TDetails>>;
}

export interface PiResources {
  getSystemPrompt(): string | undefined;
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
}

export interface PiSessionOptions {
  cwd: string;
  model: PiModel;
  modelRuntime?: PiModelRuntime;
  thinkingLevel: PiThinkingLevel;

  maxTurns?: number;
  tools: string[];
  customTools: PiToolDefinition[];
  resourceLoader: PiResources;
  settingsManager: object;
  sessionManager: object;
}

export interface PiSession {
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  subscribe(listener: (event: PiEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export type PiSessionFactory = (options: PiSessionOptions) => Promise<{ session: PiSession }>;

export interface PiRunnerCommonOptions {

  model: PiModel;
  thinkingLevel?: PiThinkingLevel;
  cwd?: string;

  tools?: PiToolDefinition[];
  /** null explicitly disables this host limit; omission preserves the default. */
  maxTurns?: number | null;
  maxSubmissions?: number | null;
  timeoutMs?: number | null;
  signal?: AbortSignal;

  onEvent?: (event: PiEvent) => void;
}

export type PiRunnerOptions = PiRunnerCommonOptions & (
  | { modelRuntime: PiModelRuntime; sessionFactory?: PiSessionFactory }
  | { modelRuntime?: PiModelRuntime; sessionFactory: PiSessionFactory }
);

export interface PiHostContext {
  cwd: string;
  model: PiModel | undefined;
  modelRegistry: {
    getAll(): readonly PiModel[];

    streamSimple(model: PiModel, context: object, options?: { signal?: AbortSignal; reasoning?: PiThinkingLevel }): AsyncIterable<unknown> & { result(): Promise<unknown> };
  };
  thinkingLevel?: PiThinkingLevel;
}
export type PiHostRunnerOptions = Omit<PiRunnerCommonOptions, "model">;
