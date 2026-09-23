import { Compile } from "typebox/compile";
import type { WorkflowDeps } from "@parcha/agentrun-dsl";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime,
  type CreateAgentSessionOptions, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PiRunnerOptions, PiSession, PiSessionOptions, PiToolDefinition } from "./types.js";
export type { PiRunnerOptions, PiSession, PiSessionFactory } from "./types.js";

export type PiRunner = NonNullable<WorkflowDeps["runNode"]>;
export type PiNodeRequest = Parameters<PiRunner>[0];

export class PiRunError extends Error {
  constructor(public readonly reason: "aborted" | "timeout" | "turn_limit" | "submission_limit" | "no_submission" | "model_error", public readonly turns: number, public readonly submissions: number) {
    super(`Pi node did not deliver an accepted submission: ${reason} (${turns} turns, ${submissions} submissions)`);
    this.name = "PiRunError";
  }
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Embedding a schema under value changes the document root of its local pointers. */
function submitParameters(schema: unknown): ToolDefinition["parameters"] {
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const singles = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "additionalItems", "contains", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]);
  const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const relocate = (node: unknown, resourceScope = false): unknown => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return structuredClone(node);
    // $id establishes a separate schema resource: its local references do not move.
    resourceScope ||= typeof (node as Record<string, unknown>).$id === "string" && (node as Record<string, unknown>).$id !== "";
    const child = (value: unknown) => relocate(value, resourceScope);
    return Object.fromEntries(Object.entries(node).map(([key, value]) => {
      if (!resourceScope && key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
        return [key, `#/properties/value${value.slice(1)}`];
      }
      if (maps.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        return [key, Object.fromEntries(Object.entries(value).map(([name, value]) => [name, child(value)]))];
      }
      if (arrays.has(key) && Array.isArray(value)) return [key, value.map(child)];
      if (singles.has(key)) return [key, Array.isArray(value) ? value.map(child) : child(value)];
      if (key === "dependencies" && value && typeof value === "object" && !Array.isArray(value)) {
        return [key, Object.fromEntries(Object.entries(value).map(([name, value]) => [name, Array.isArray(value) ? structuredClone(value) : child(value)]))];
      }
      // Annotations and literal values are data, not schemas (including a literal $ref).
      return [key, structuredClone(value)];
    }));
  };
  return { type: "object", properties: { value: relocate(schema) }, required: ["value"], additionalProperties: false } as ToolDefinition["parameters"];
}

export function createPiRunner(options: PiRunnerOptions): PiRunner {
  if (!options.model || (!options.modelRuntime && !options.sessionFactory)) throw new Error("Pi requires an explicit model and modelRuntime, or a host-owned sessionFactory");
  if (!options.sessionFactory && !(options.modelRuntime instanceof ModelRuntime)) throw new Error("modelRuntime must be a ModelRuntime instance from the supported Pi SDK");
  const maxTurns = options.maxTurns === null ? null : positive(options.maxTurns ?? 8, "maxTurns");
  const maxSubmissions = options.maxSubmissions === null ? null : positive(options.maxSubmissions ?? 5, "maxSubmissions");
  const timeoutMs = options.timeoutMs === null ? null : positive(options.timeoutMs ?? 120_000, "timeoutMs");
  const names = new Set<string>();
  for (const tool of options.tools ?? []) {
    if (tool.name === "submit" || names.has(tool.name)) throw new Error(`Reserved or duplicate Pi tool: ${tool.name}`);
    names.add(tool.name);
  }
  return async (request) => {
    const signals = [options.signal, request.signal].filter((s): s is AbortSignal => Boolean(s));
    if (signals.some(s => s.aborted)) throw new PiRunError("aborted", 0, 0);
    const requested = request.tools ?? [...names];
    for (const name of requested) if (!names.has(name)) throw new Error(`Pi tool was not explicitly registered: ${name}`);
    const validator = Compile(request.schema as never);
    const parameters = submitParameters(request.schema);
    const envelopeValidator = Compile(parameters as never);
    let session: PiSession | undefined;
    let turns = 0, submissions = 0;
    let accepted = false;
    let submission: unknown;
    const pendingSubmissions = new Map<string, { args?: unknown; executed: boolean }>();
    let stopped: PiRunError["reason"] | undefined;
    let fatal: unknown;
    let rejectStopped!: (error: unknown) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });

    void interrupted.catch(() => {});
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, interrupted]);
    const clean = (target: PiSession) => {

      void target.abort().catch(() => {});
      target.dispose();
    };
    const stop = (reason?: PiRunError["reason"]) => {
      stopped ??= reason;
      if (fatal) rejectStopped(fatal);
      else if (stopped) rejectStopped(new PiRunError(stopped, turns, submissions));

      void session?.abort().catch(() => {});
    };
    const onAbort = () => stop("aborted");
    signals.forEach(s => s.addEventListener("abort", onAbort, { once: true }));
    const timer = timeoutMs === null ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
    let unsubscribe: (() => void) | undefined;
    const result = (text: string, ok: boolean) => ({ content: [{ type: "text" as const, text }], details: { accepted: ok } });
    const submit: ToolDefinition = {
      name: "submit", label: "Submit result", description: "Deliver a result matching the required JSON Schema. Rejection feedback must be corrected in this session.",

      parameters,
      executionMode: "sequential",
      async execute(id, args) {
        if (accepted) return result("Already accepted; end your turn.", true);
        if (stopped || fatal) return result("This session has stopped.", false);
        const pending = pendingSubmissions.get(id);
        const original = pending && !pending.executed && Object.hasOwn(pending, "args") ? pending.args : args;
        if (pending && !pending.executed) pending.executed = true;
        else submissions++;
        try {
          const candidate = (original as { value?: unknown } | null)?.value;
          let message: string | undefined;
          if (!envelopeValidator.Check(original)) message = JSON.stringify([...envelopeValidator.Errors(original)]);
          else if (!validator.Check(candidate)) message = JSON.stringify([...validator.Errors(candidate)]);
          else if (request.review) {
            const verdict = await request.review(candidate);
            if (!verdict.accepted) message = verdict.message;
            else if (!validator.Check(candidate)) message = "The reviewed candidate no longer satisfies its output schema";
          }
          if (stopped) return result("This session has stopped.", false);
          if (message !== undefined) {
            if (maxSubmissions !== null && submissions >= maxSubmissions) stop("submission_limit");
            return result(`Rejected: ${message}. Correct the result and call submit again.`, false);
          }
          submission = structuredClone(candidate);
          accepted = true;
          return result("Accepted. End your turn.", true);
        } catch (error) {
          fatal = error;
          stop();
          return result("The host verifier failed; execution stopped.", false);
        }
      },
    };
    try {
      const cwd = options.cwd ?? process.cwd();
      const settingsManager = SettingsManager.inMemory({
        enableAnalytics: false, enableInstallTelemetry: false,
        retry: { enabled: false }, compaction: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: [...request.system, 'Only a successful submit tool call delivers the result. Call submit with {"value": YOUR_RESULT}. The schema below describes value, not the envelope.', `Required JSON Schema: ${JSON.stringify(request.schema)}`].join("\n\n"),
        appendSystemPromptOverride: () => [], agentsFilesOverride: () => ({ agentsFiles: [] }),
      });
      await bounded(resourceLoader.reload());
      if (stopped) throw new PiRunError(stopped, turns, submissions);
      const sessionManager = SessionManager.inMemory(cwd);
      const prepared: PiSessionOptions = {
        cwd, model: options.model, modelRuntime: options.modelRuntime,
        thinkingLevel: request.thinking ?? options.thinkingLevel ?? "low", maxTurns: maxTurns ?? undefined, resourceLoader, settingsManager,
        sessionManager,
        tools: [...requested, "submit"],
        customTools: [...(options.tools ?? []).filter(tool => requested.includes(tool.name)).map(tool => ({
          ...tool,
          executionMode: "sequential" as const,
          execute: ((...args: Parameters<PiToolDefinition["execute"]>) => {
            if (accepted || stopped || fatal) throw new Error("Pi session has stopped; tool execution refused");
            return tool.execute(...args);
          }) as PiToolDefinition["execute"],
        })), submit],
      };

      const opening = (options.sessionFactory
        ? options.sessionFactory(prepared)
        : createAgentSession({
          ...prepared,
          model: options.model as NonNullable<CreateAgentSessionOptions["model"]>,
          modelRuntime: options.modelRuntime as ModelRuntime,
          resourceLoader, settingsManager, sessionManager,
          customTools: prepared.customTools as ToolDefinition[],
        })).then(opened => {
        if (stopped || fatal) clean(opened.session);
        return opened;
      });
      ({ session } = await bounded(opening));
      if (stopped) throw new PiRunError(stopped, turns, submissions);
      unsubscribe = session.subscribe(event => {
        // Native events carry correlation IDs, including SDK-rejected calls. Custom
        // sessions without IDs use execute's counter so one attempt is not counted twice.
        if (event.type === "tool_execution_start" && event.toolName === "submit" && event.toolCallId !== undefined && !accepted && !stopped && !fatal) {
          submissions++;
          pendingSubmissions.set(event.toolCallId, {
            ...(Object.hasOwn(event, "args") ? { args: structuredClone(event.args) } : {}), executed: false,
          });
          if (maxSubmissions !== null && submissions > maxSubmissions) stop("submission_limit");
        }
        if (event.type === "tool_execution_end" && event.toolName === "submit") {
          if (event.toolCallId !== undefined) pendingSubmissions.delete(event.toolCallId);
          if (!accepted && !stopped && !fatal && maxSubmissions !== null && submissions >= maxSubmissions) stop("submission_limit");
        }
        if (event.type === "turn_start") turns++;
        if (event.type === "turn_end" && !accepted && event.message?.role === "assistant" && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) stop(event.message.stopReason === "error" ? "model_error" : "aborted");
        if (event.type === "turn_end" && (accepted || fatal || maxTurns !== null && turns >= maxTurns)) stop(accepted || fatal ? undefined : "turn_limit");
        options.onEvent?.(event);
      });
      let prompt = request.user;
      while (!accepted && !stopped && !fatal && (maxTurns === null || turns < maxTurns)) {
        const before = turns;
        await bounded(session.prompt(prompt, { expandPromptTemplates: false }));

        if (turns === before) turns++;
        prompt = "You finished without an accepted submission. Call submit with the complete result; plain text does not deliver it.";
      }
      if (fatal) throw fatal;
      if (stopped) throw new PiRunError(stopped, turns, submissions);
      if (accepted) return submission;
      throw new PiRunError(maxTurns !== null && turns >= maxTurns ? "turn_limit" : "no_submission", turns, submissions);
    } catch (error) {
      if (fatal) throw fatal;
      if (stopped) throw new PiRunError(stopped, turns, submissions);
      if (accepted) return submission;
      throw error;
    } finally {
      clearTimeout(timer);
      signals.forEach(s => s.removeEventListener("abort", onAbort));
      unsubscribe?.();
      if (session) clean(session);
    }
  };
}
