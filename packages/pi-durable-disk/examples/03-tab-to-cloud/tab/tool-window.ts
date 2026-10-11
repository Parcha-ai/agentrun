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
import { renderPrompt, selectTools, type HostTool, type Msg, type ToolSpec } from "./tool-format.ts";

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
    for (let i = at - 1; i >= 0; i--) {
      if (real[i]!.role !== "user") continue;
      let answer: PiMessage | undefined;
      let ours = true;
      for (let j = i + 1; j < at && real[j]!.role !== "user"; j++) {
        const m = real[j]!;
        if (m.role !== "assistant") continue;
        if (m.provider !== o.provider) { ours = false; break; } // the trip's turns (another model) are never shown
        if (!isHeld(m) && m.stopReason !== "error" && m.stopReason !== "aborted" && !hasCall(m.content) && textOf(m.content).trim()) answer = m;
      }
      if (ours && answer) {
        out.push({ role: "user", content: textOf(real[i]!.content) });
        // the final turn as the model wrote it: its thinking and its answer text, no call
        out.push({ role: "assistant", content: parts(answer.content).filter((p) => p.type === "thinking" || p.type === "text") } as Msg);
      }
      break; // only the exchange right before: held, failed or the trip's, it is skipped and nothing older is reached for
    }
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
export function toolPrompt(messages: readonly PiMessage[], o: WindowOptions): { prompt: string; tools: ToolSpec[]; window: Msg[] } {
  const tools = currentTools(messages);
  const window = windowMessages(messages, o);
  return { prompt: renderPrompt(tools, window), tools, window };
}
