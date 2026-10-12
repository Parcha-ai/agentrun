// What the tab-local model is shown of a conversation that has TOOLS: a window, not the transcript. The conversation is one (it did the trip on the cloud model, then was
// configured onto this model), but the small model never reads the trip. The window starts at a user message and holds, in order:
//   - the previous exchange (`last`): its user message and the final answer this model gave to it (with that turn's thinking, as the format renders every model turn), only when
//     THIS model gave it: never the trip's turns, never an earlier tool loop;
//   - the current task: its user message, then this model's own turns since it (thinking + call, or thinking + answer) and the results of the calls IT made.
// Never another model's assistant turn or tool call or result (the trip's reasoning is encrypted: it would render with empty thinking, which training never had), never a system
// message. The prompt is then the format's own `renderPrompt(tools, window)`: the same bytes training saw (tool-format.ts, D1's module).
// Pure: it reads pi's message shapes structurally, so the page's provider and the Node tests share it.
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { isHeld, type HistoryMode, type PiMessageLike } from "../../04-walks-home/tab/src/history.ts";
import { renderPrompt, selectTools, windowLast, type HostTool, type Msg, type ToolSpec } from "./tool-format.ts";

interface Part { type?: string; text?: string; id?: string }
type PiMessage = PiMessageLike & { provider?: string; toolCallId?: string; toolName?: string; isError?: boolean };

const parts = (content: unknown): Part[] => (Array.isArray(content) ? (content as Part[]) : typeof content === "string" ? [{ type: "text", text: content }] : []);
const hasCall = (content: unknown): boolean => parts(content).some((p) => p.type === "toolCall");
const textOf = (content: unknown): string => parts(content).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");

export interface WindowOptions {
  /** The provider id of this model: only its assistant turns are shown back to it. */
  provider: string;
  mode: HistoryMode;
}

export function windowMessages(messages: readonly PiMessage[], o: WindowOptions): Msg[] {
  const real = messages.filter((m) => m.role !== "system");
  let at = -1;
  for (let i = real.length - 1; i >= 0; i--) if (real[i]!.role === "user") { at = i; break; }
  if (at < 0) return [];
  const out: Msg[] = [];
  if (o.mode === "last") {
    // D1's `last` window (tool-format.ts windowLast), the one the model was trained with: the previous request and its final answer (thinking and text, no tool loop), only when THIS model
    // gave it; a previous task with no final answer, or another model's (the trip's), is left out and nothing older is reached for. A held or failed answer is no answer.
    const usable = real.slice(0, at + 1).filter((m) => !(m.role === "assistant" && (isHeld(m) || m.stopReason === "error" || m.stopReason === "aborted")));
    const w = windowLast(usable.map((m) => ({ ...m, content: m.role === "user" ? textOf(m.content) : m.content })) as unknown as Msg[], (m) => (m as unknown as PiMessage).provider === o.provider);
    out.push(...w.slice(0, -1)); // the current request follows below
  }
  out.push({ role: "user", content: textOf(real[at]!.content) });
  // The calls this model made in the task: only their results come back. A task another model began (the trip's last request: Luna's go_offline) has calls and results of its own that are never shown.
  const own = new Set<string>();
  for (let j = at + 1; j < real.length; j++) {
    const m = real[j]!;
    if (m.role === "assistant" && m.provider === o.provider) {
      for (const p of parts(m.content)) if (p.type === "toolCall" && p.id) own.add(p.id);
      out.push({ role: "assistant", content: parts(m.content).filter((p) => p.type === "thinking" || p.type === "text" || p.type === "toolCall") } as Msg);
    } else if (m.role === "toolResult" && own.has(m.toolCallId ?? "")) {
      out.push({ role: "toolResult", toolCallId: m.toolCallId!, toolName: m.toolName ?? "tool", content: parts(m.content).filter((p) => p.type === "text"), isError: m.isError === true } as Msg);
    }
  }
  return out;
}

/** The tools the conversation has now, as the format offers them (pi's replay of the transcript's system messages; throws when a tool's arguments differ from the format's). */
export function currentTools(messages: readonly PiMessageLike[]): ToolSpec[] {
  return selectTools(getCurrentTools(messages as never) as HostTool[]);
}

/** Whether the conversation has tools now: the provider then reads the window, else the plain history policy. */
export const hasTools = (messages: readonly PiMessageLike[]): boolean => (getCurrentTools(messages as never) as HostTool[]).length > 0;

/** The prompt for the model's next turn: the format's own rendering of the window. */
/** The model's context in tokens (04-walks-home/tab/src/llm.ts N_CTX: a test holds them equal); the prompt gets what the reply does not need. A token is about 3 characters of code and JSON (conservative). */
export const CONTEXT_TOKENS = 2048;
export const CHARS_PER_TOKEN = 3;

/**
 * A prompt over `maxChars` loses the OLDEST complete call/result pairs of the current task, never the request (the user message) and never the newest pair: a task with several reads or writes
 * would otherwise outgrow the context and the model would see a prompt cut in the middle. Returns the window that fits (or the smallest one the rule allows) and how many pairs were dropped.
 */
export function fitWindow(window: readonly Msg[], render: (w: readonly Msg[]) => string, maxChars: number): { window: Msg[]; dropped: number } {
  let w = [...window];
  let dropped = 0;
  while (render(w).length > maxChars) {
    const user = w.map((m) => m.role).lastIndexOf("user");
    const first = w.findIndex((m, i) => i > user && m.role === "assistant");
    if (first < 0) break;
    const end = w.findIndex((m, i) => i > first && m.role === "assistant");
    if (end < 0) break; // the only pair: it is the newest, and it stays
    // a pair is the model's turn and every result that answers it, up to the next turn of the model
    w = [...w.slice(0, first), ...w.slice(end)];
    dropped++;
  }
  return { window: w, dropped };
}

export function toolPrompt(messages: readonly PiMessage[], o: WindowOptions & { maxPromptChars?: number }): { prompt: string; tools: ToolSpec[]; window: Msg[]; dropped: number; steps: number } {
  const tools = currentTools(messages);
  const full = windowMessages(messages, o);
  const { window, dropped } = o.maxPromptChars === undefined ? { window: full, dropped: 0 } : fitWindow(full, (w) => renderPrompt(tools, w as Msg[]), o.maxPromptChars);
  const user = full.map((m) => m.role).lastIndexOf("user");
  const steps = full.slice(user + 1).filter((m) => m.role === "assistant").length; // the model's own turns in this task, before any pair is dropped
  return { prompt: renderPrompt(tools, window), tools, window, dropped, steps };
}
