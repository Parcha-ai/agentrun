// What the tab-local model is shown of a conversation that has TOOLS: a window, not the transcript. The conversation is one (it did the trip on the cloud model, then was
// configured onto this model), but the small model never reads the trip. The window is, in order:
//   - the tool prompt: the conversation's CURRENT instructions and tools (pi's own replay of the transcript's system messages), put in the first user turn;
//   - the previous exchange (`last`): the user message and the answer TEXT it got, only when this model gave that answer (never the trip's turns, never its tool calls);
//   - the current task: its user message and this model's own tool loop since it (assistant turns with their calls, tool results as user turns).
// Never any thinking, never an assistant turn another model wrote, never a system message, never the trip's tool calls or results. Roles alternate (Gemma's template needs it).
// Pure: it reads pi's message shapes structurally, so the page's provider and the Node tests share it.
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { isHeld, type HistoryMode, type PiMessageLike } from "../../04-walks-home/tab/src/history.ts";
import type { ChatMsg } from "../../04-walks-home/tab/src/modelhost.ts";
import type { ToolCall, ToolFormat, ToolSpecLike } from "./tool-format.ts";

interface Part { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }
type PiMessage = PiMessageLike & { provider?: string; toolName?: string; isError?: boolean };

const parts = (content: unknown): Part[] => (Array.isArray(content) ? (content as Part[]) : typeof content === "string" ? [{ type: "text", text: content }] : []);
const textOf = (content: unknown): string => parts(content).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
const callsOf = (content: unknown): ToolCall[] => parts(content).filter((p) => p.type === "toolCall").map((p) => ({ name: p.name ?? "", arguments: p.arguments ?? {} }));

export interface WindowOptions {
  /** The provider id of this model: only its assistant turns are shown back to it. */
  provider: string;
  format: ToolFormat;
  mode: HistoryMode;
}

/** The tools and instructions the conversation has now (pi's replay of its system messages). */
export function currentToolPrompt(messages: readonly PiMessageLike[], format: ToolFormat): { prompt: string; tools: ToolSpecLike[] } {
  const instructions = getCurrentSystemPrompt(messages as never).replace(/^<instructions>\n?|\n?<\/instructions>$/g, "").trim();
  const tools = getCurrentTools(messages as never) as ToolSpecLike[];
  return { prompt: format.prompt(instructions, tools), tools };
}

export function windowMessages(messages: readonly PiMessage[], o: WindowOptions): ChatMsg[] {
  const real = messages.filter((m) => m.role !== "system");
  let at = -1;
  for (let i = real.length - 1; i >= 0; i--) if (real[i]!.role === "user") { at = i; break; }
  if (at < 0) return [];
  const turns: ChatMsg[] = [];
  // the previous exchange, when this model gave it
  if (o.mode === "last") {
    for (let i = at - 1; i >= 0; i--) {
      if (real[i]!.role !== "user") continue;
      let answer = "";
      let ours = true;
      for (let j = i + 1; j < at && real[j]!.role !== "user"; j++) {
        const m = real[j]!;
        if (m.role !== "assistant") continue;
        if (m.provider !== o.provider) { ours = false; break; } // the trip's turns (another model) are never shown
        if (!isHeld(m) && m.stopReason !== "error" && m.stopReason !== "aborted" && callsOf(m.content).length === 0) answer = textOf(m.content).trim() || answer;
      }
      if (ours && answer) turns.push({ role: "user", content: textOf(real[i]!.content) }, { role: "assistant", content: answer });
      break; // only the exchange right before: held, failed or the trip's, it is skipped and nothing older is reached for
    }
  }
  // the current task: its message, then this model's own loop since it
  turns.push({ role: "user", content: textOf(real[at]!.content) });
  // The tool calls this model made in the task: only their results are shown back. A task another model began (the trip's last request: Luna's go_offline) has calls and results of its own that are never shown.
  const own = new Set<string>();
  for (let j = at + 1; j < real.length; j++) {
    const m = real[j]!;
    if (m.role === "assistant" && m.provider === o.provider) {
      for (const p of parts(m.content)) if (p.type === "toolCall" && p.id) own.add(p.id);
      const calls = callsOf(m.content);
      const said = textOf(m.content).trim();
      const body = [said, ...calls.map((c) => o.format.renderCall(c))].filter(Boolean).join("\n");
      if (body) turns.push({ role: "assistant", content: body });
    } else if (m.role === "toolResult" && own.has((m as { toolCallId?: string }).toolCallId ?? "")) {
      turns.push({ role: "user", content: o.format.renderResult(m.toolName ?? "tool", textOf(m.content), m.isError === true) });
    }
  }
  // roles must alternate: neighbours with the same role are one turn
  const merged: ChatMsg[] = [];
  for (const t of turns) {
    const prev = merged.at(-1);
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n${t.content}`;
    else merged.push({ ...t });
  }
  return merged;
}

/** The window with the tool prompt put at the head of its first user turn. */
export function windowWithPrompt(messages: readonly PiMessage[], o: WindowOptions): ChatMsg[] {
  const turns = windowMessages(messages, o);
  if (turns.length === 0) return turns;
  const { prompt } = currentToolPrompt(messages, o.format);
  if (prompt && turns[0]!.role === "user") turns[0] = { role: "user", content: `${prompt}\n\n${turns[0]!.content}` };
  return turns;
}

/** Whether the conversation has tools now: the provider then reads the window, else the plain history policy. */
export const hasTools = (messages: readonly PiMessageLike[]): boolean => getCurrentTools(messages as never).length > 0;
