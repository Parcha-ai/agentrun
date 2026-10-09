// The chat as the page shows it, folded from pi's agent events (a snapshot, then one batch per commit). The writer tab
// folds its own Harness's events; a viewer folds the same events relayed by the pipe or by the cloud host, so every
// device shows the same transcript. Portable, no DOM.
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: string; output: string; status: "running" | "done" | "error" | "interrupted" }
  | { kind: "note"; id: string; text: string };

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; errorMessage?: string; stopReason?: string };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("") : "";

const messagesOf = (entry: EntryRecord): Message[] => ((entry as unknown as { model?: Message[] }).model ?? []);

export class ChatView {
  #entries: EntryRecord[] = [];
  #ids = new Set<string>();
  #inflight: { content: Block[] } | undefined;
  #tools = new Map<string, { name: string; args: string; output: string; running: boolean }>();
  #retry: string | undefined;
  busy = false;

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "snapshot":
        this.#entries = [...event.entries];
        this.#ids = new Set(this.#entries.map((e) => String(e.id)));
        this.#inflight = event.generation?.message ? { content: [...(event.generation.message.content as Block[])] } : undefined;
        this.#retry = event.generation?.retry ? event.generation.retry.error : undefined;
        this.#tools.clear();
        for (const slot of event.tools) this.#tools.set(slot.callId, { name: slot.name, args: "", output: slot.output ?? "", running: slot.status !== "done" });
        this.busy = event.run !== undefined;
        return;
      case "run_start":
        this.busy = true;
        return;
      case "run_end":
        this.busy = false;
        this.#inflight = undefined;
        return;
      case "message_start":
        if (event.message.role === "assistant") this.#inflight = { content: [] };
        return;
      case "message_update": {
        const inflight = (this.#inflight ??= { content: [] });
        for (const change of event.changes) {
          if (change.type === "text_start" || change.type === "thinking_start" || change.type === "toolcall_start" || change.type === "block") {
            inflight.content[change.contentIndex] = { ...(change.block as Block) };
          } else if (change.type === "text_delta") {
            const block = (inflight.content[change.contentIndex] ??= { type: "text", text: "" });
            block.text = (block.text ?? "") + change.delta;
          } else if (change.type === "thinking_delta") {
            const block = (inflight.content[change.contentIndex] ??= { type: "thinking", thinking: "" });
            block.thinking = (block.thinking ?? "") + change.delta;
          } else if (change.type === "message") {
            inflight.content = [...(change.message.content as Block[])];
          }
        }
        return;
      }
      case "message_end":
        this.#inflight = undefined;
        this.#add(event.entry);
        return;
      case "entry_appended":
        this.#add(event.entry);
        return;
      case "tool_execution_start":
        this.#tools.set(event.toolCallId, { name: event.toolName, args: JSON.stringify(event.args), output: "", running: true });
        return;
      case "tool_execution_update": {
        const tool = this.#tools.get(event.toolCallId);
        if (!tool || !event.output) return;
        if ("set" in event.output) tool.output = event.output.set;
        else tool.output = tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
        return;
      }
      case "tool_execution_end": {
        const tool = this.#tools.get(event.toolCallId);
        if (tool) tool.running = false;
        if (event.entry) this.#add(event.entry);
        return;
      }
      case "auto_retry_start":
        this.#retry = event.errorMessage;
        return;
      case "auto_retry_end":
        this.#retry = undefined;
        return;
      default:
        return;
    }
  }

  #add(entry: EntryRecord): void {
    const id = String(entry.id);
    if (this.#ids.has(id)) return;
    this.#ids.add(id);
    this.#entries.push(entry);
  }

  /** The transcript as chat items, oldest first, the streaming answer last. */
  items(): ChatItem[] {
    const items: ChatItem[] = [];
    const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
    const pushAssistant = (id: string, content: Block[], streaming: boolean, error?: string) => {
      const text = content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
      const thinking = content.filter((b) => b?.type === "thinking").map((b) => b.thinking ?? "").join("");
      if (text || thinking || streaming) items.push({ kind: "assistant", id, text, thinking, streaming });
      for (const block of content) {
        if (block?.type !== "toolCall" || !block.id) continue;
        const live = this.#tools.get(block.id);
        const tool: Extract<ChatItem, { kind: "tool" }> = {
          kind: "tool",
          id: block.id,
          name: block.name ?? live?.name ?? "tool",
          args: block.arguments === undefined ? live?.args ?? "" : typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
          output: live?.output ?? "",
          status: "running",
        };
        tools.set(block.id, tool);
        items.push(tool);
      }
      if (error) items.push({ kind: "note", id: `${id}-error`, text: error });
    };
    for (const entry of this.#entries) {
      const id = String(entry.id);
      for (const message of messagesOf(entry)) {
        if (entry.kind === "pi.user" && message.role === "user") items.push({ kind: "user", id, text: textOf(message.content) });
        else if (entry.kind === "pi.assistant" && message.role === "assistant") {
          const error = message.stopReason === "error" ? `model error: ${message.errorMessage ?? "unknown"}` : undefined;
          pushAssistant(id, (message.content as Block[]) ?? [], false, error);
        } else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
          const tool = tools.get(message.toolCallId ?? "");
          const output = textOf(message.content);
          if (tool) {
            tool.output = output;
            tool.status = message.isError ? (/interrupted/i.test(output) ? "interrupted" : "error") : "done";
          } else items.push({ kind: "tool", id, name: message.toolName ?? "tool", args: "", output, status: message.isError ? "error" : "done" });
        }
      }
    }
    if (this.#inflight) pushAssistant("inflight", this.#inflight.content, true);
    if (this.#retry) items.push({ kind: "note", id: "retry", text: `retrying: ${this.#retry}` });
    return items;
  }
}
