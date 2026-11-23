// pi: ~/.pi/agent/sessions/--<cwd>--/<time>_<session id>.jsonl. pi prices each request itself.
import { basename, join } from "node:path";
import { type LineSource, lineReader, type ReadContext } from "../lines.js";
import { entries } from "../reader.js";
import { argsOf, effortOf, isObject, str, textOf, timeOf } from "../text.js";
import type { ToolCall } from "../types.js";
import { normalizeUsage } from "../usage.js";

function record(value: Record<string, unknown>, at: number, { state, keep, add }: ReadContext<undefined>): void {
  const { session, priced } = state;
  if (value.type === "session") {
    if (str(value.id)) session.id = value.id as string;
    if (str(value.cwd)) session.cwd = value.cwd as string;
    return;
  }
  if (value.type === "model_change") {
    if (str(value.provider) && str(value.modelId)) session.model = `${value.provider}/${value.modelId}`;
    return;
  }
  if (value.type === "thinking_level_change") {
    state.effort = effortOf(value.thinkingLevel);
    return;
  }
  if (value.type !== "message" || !isObject(value.message)) return;
  const message = value.message;
  const when = timeOf(message.timestamp) ?? at;
  if (message.role === "user") add({ role: "user", text: textOf(message.content), at: when });
  else if (message.role === "toolResult")
    add({
      role: "toolResult",
      callId: String(message.toolCallId ?? ""),
      name: String(message.toolName ?? ""),
      text: textOf(message.content),
      isError: message.isError === true,
      at: when,
    });
  else if (message.role === "assistant") {
    if (str(message.provider) && str(message.model)) session.model = `${message.provider}/${message.model}`;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((b) => isObject(b) && b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    const calls: ToolCall[] = blocks
      .filter((b): b is Record<string, unknown> => isObject(b) && b.type === "toolCall")
      .map((b) => ({
        type: "toolCall",
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        arguments: keep ? argsOf(b.arguments) : {},
      }));
    const usage = isObject(message.usage) && isObject(message.usage.cost) ? message.usage.cost : undefined;
    const cost = typeof usage?.total === "number" && Number.isFinite(usage.total) && usage.total >= 0 ? usage.total : undefined;
    // pi prices each request: the session's cost is their sum, unknown once one is not priced.
    priced.sum += cost ?? 0;
    priced.unknown ||= cost === undefined;
    session.costUsd = priced.unknown ? undefined : priced.sum;
    session.state = message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "stopped" : "completed";
    // A request cut before its end has only the start of its counts: unknown, as a live run's.
    const tokens = message.stopReason === "aborted" ? undefined : normalizeUsage("pi", message.usage);
    // Without turns, no answer text, nor a failed request's error message: the request is kept for its counts.
    add({
      role: "assistant",
      text: keep ? text : "",
      calls,
      at: when,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      ...(tokens ? { usage: tokens } : {}),
      ...(message.stopReason === "error" ? { error: keep ? (str(message.errorMessage) ?? "unknown error") : "API error" } : {}),
    });
  }
}

const spec: LineSource<"pi", undefined> = {
  source: "pi",
  name: "pi",
  harness: "pi",
  async files(home) {
    const root = join(home, ".pi", "agent", "sessions");
    const out: string[] = [];
    for (const project of await entries(root)) {
      if (!project.isDirectory()) continue;
      for (const file of await entries(join(root, project.name))) if (file.isFile() && file.name.endsWith(".jsonl")) out.push(join(root, project.name, file.name));
    }
    return out;
  },
  start: () => undefined,
  record,
  idOf: (file) => basename(file, ".jsonl").split("_").pop()!,
};

export const pi = lineReader(spec);
