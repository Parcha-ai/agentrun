// The chat as the page shows it, folded from pi's agent events (a snapshot, then one batch per commit). The writer tab
// folds its own Harness's events; a viewer folds the same events relayed by the pipe or by the cloud host, so every
// device shows the same transcript. Portable, no DOM.
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { NOTICE_KIND } from "../environment.ts";
import { SERVER_TURN } from "../placement.ts";
import { BRAIN_CHECKIN, BRAIN_DECISION, BRAIN_FAILED, BRAIN_LOADING, BRAIN_MOVE, BRAIN_SWAP } from "./brain-kinds.ts";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: string; output: string; status: "running" | "done" | "error" | "interrupted"; /** What the harness said about the call, typed (its `<harness>` block is not in `output`). */ diagnostics?: Diagnostic[]; /** The tool's own typed details (teach_skills: its threads and what came home). */ details?: unknown }
  | { kind: "note"; id: string; text: string }
  /** The notice of a move, as the agent received it (environment.ts). */
  | { kind: "switch"; id: string; text: string; switchId: string; planned: boolean; /** Where it went, as the host calls itself (the notice's facts.label); who decided (`by`, "jev") and how sure (`probability`). The page shows these, never `text`. */ to?: string | null; by?: string | null; probability?: number | null }
  /** The trained model coming home and becoming the agent's brain (brain.ts): `loading`, then `ready` (the swap) or `failed`. `data` is the entry's data as written. */
  | { kind: "brain"; id: string; stage: "loading" | "ready" | "failed" | "moved" | "home" | "decision"; text: string; data: Record<string, unknown> };

export type Diagnostic = { severity: string; code?: string; message: string };

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; errorMessage?: string; stopReason?: string; details?: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("") : "";

/** The harness's own rendering of a result's diagnostics, appended to the content the model sees (pi-durable's appendToolResult). */
const renderedDiagnostics = (d: readonly Diagnostic[]): string => `<harness>\n${d.map((x) => `[${x.severity}] ${x.message}`).join("\n")}\n</harness>`;

/** The typed diagnostics the harness recorded with a tool-result entry. */
function diagnosticsOf(entry: EntryRecord): Diagnostic[] {
  const list = (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics;
  if (!Array.isArray(list)) return [];
  return list.flatMap((d) => {
    const o = d as { severity?: unknown; code?: unknown; message?: unknown } | null;
    return o && typeof o.severity === "string" && typeof o.message === "string" ? [{ severity: o.severity, ...(typeof o.code === "string" ? { code: o.code } : {}), message: o.message }] : [];
  });
}

/** The result's text without the harness's rendered diagnostics: the last text item, removed only when it is exactly that rendering (no pattern matching on prose). */
function textWithout(content: unknown, diagnostics: readonly Diagnostic[]): string {
  if (!Array.isArray(content) || diagnostics.length === 0) return textOf(content);
  const items = [...(content as { type?: string; text?: string }[])];
  const last = items.map((c) => c.type === "text").lastIndexOf(true);
  if (last >= 0 && items[last]!.text === renderedDiagnostics(diagnostics)) items.splice(last, 1);
  return textOf(items);
}

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
    // A failed model call that pi retried: an answer comes after it.
    const lastAnswer = this.#entries.reduce((at, e, i) => (e.kind === "pi.assistant" ? i : at), -1);
    const swaps = new Set<unknown>();
    for (const [index, entry] of this.#entries.entries()) {
      const id = String(entry.id);
      if (entry.kind === BRAIN_LOADING || entry.kind === BRAIN_SWAP || entry.kind === BRAIN_FAILED || entry.kind === BRAIN_MOVE || entry.kind === BRAIN_CHECKIN || entry.kind === BRAIN_DECISION) {
        const data = (entry.data ?? {}) as Record<string, unknown>;
        if (entry.kind === BRAIN_SWAP) { const key = `${String(data.conversation)}:${String(data.sha256)}`; if (swaps.has(key)) continue; swaps.add(key); } // the root's pointer and the new conversation's first entry say the same thing once
        if (entry.kind === BRAIN_MOVE) { if (swaps.has(data.switchId)) continue; swaps.add(data.switchId); } // a move is written in both conversations too
        items.push({ kind: "brain", id, stage: entry.kind === BRAIN_LOADING ? "loading" : entry.kind === BRAIN_SWAP ? "ready" : entry.kind === BRAIN_MOVE ? "moved" : entry.kind === BRAIN_CHECKIN ? "home" : entry.kind === BRAIN_DECISION ? "decision" : "failed", text: brainText(entry.kind, data), data });
        continue;
      }
      // A notice the host writes for the agent (a check-in prompt, a status line: any `env.*` kind but the move's) is the agent's context, never the reader's chat.
      if (entry.kind.startsWith("env.") && entry.kind !== NOTICE_KIND) continue;
      if (entry.kind === NOTICE_KIND) {
        const data = (entry.data ?? {}) as { switchId?: string; planned?: boolean; by?: unknown; probability?: unknown; facts?: { label?: unknown } };
        items.push({ kind: "switch", id, text: messagesOf(entry).map((m) => textOf(m.content)).join(""), switchId: data.switchId ?? "", planned: data.planned !== false, to: typeof data.facts?.label === "string" ? data.facts.label : null, by: typeof data.by === "string" ? data.by : null, probability: typeof data.probability === "number" && Number.isFinite(data.probability) ? data.probability : null });
        continue;
      }
      for (const message of messagesOf(entry)) {
        // The server's own turns (the home check-in after a move) are for the model: the person's chat shows the agent's reply to them, never the server's words as if the person had said them.
        if (entry.kind === "pi.user" && message.role === "user") {
          const said = textOf(message.content);
          if (!said.startsWith(SERVER_TURN)) items.push({ kind: "user", id, text: said });
        }
        else if (entry.kind === "pi.assistant" && message.role === "assistant") {
          const error = message.stopReason === "error" ? `${index < lastAnswer ? "model call failed, retried" : "model error"}: ${message.errorMessage ?? "unknown"}` : undefined;
          pushAssistant(id, (message.content as Block[]) ?? [], false, error);
        } else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
          const tool = tools.get(message.toolCallId ?? "");
          const diagnostics = diagnosticsOf(entry);
          const output = textWithout(message.content, diagnostics);
          const typed = { ...(diagnostics.length > 0 ? { diagnostics } : {}), ...(message.details !== undefined ? { details: message.details } : {}) };
          if (tool) {
            tool.output = output;
            tool.status = message.isError ? (/interrupted/i.test(output) ? "interrupted" : "error") : "done";
            Object.assign(tool, typed);
          } else items.push({ kind: "tool", id, name: message.toolName ?? "tool", args: "", output, status: message.isError ? "error" : "done", ...typed });
        }
      }
    }
    if (this.#inflight) pushAssistant("inflight", this.#inflight.content, true);
    if (this.#retry) items.push({ kind: "note", id: "retry", text: `retrying: ${this.#retry}` });
    return items;
  }
}

const mb = (bytes: unknown) => (typeof bytes === "number" ? `${Math.round(bytes / 1e6)} MB` : "");

/** The words for a brain entry, as a reader sees them in the chat. */
export function brainText(kind: string, data: Record<string, unknown>): string {
  const name = typeof data.name === "string" ? data.name : "the trained model";
  if (kind === BRAIN_LOADING) return `The model this run trained is coming home: ${name}${data.bytes ? `, ${mb(data.bytes)}` : ""}.`;
  if (kind === BRAIN_SWAP && data.mode === "configure") return `The agent's brain is now the model it trained: ${name}${typeof data.topic === "string" ? `, obsessed with ${data.topic}` : ""}, running in this tab. The same conversation, with its tools: the model reads the tool prompt and the task in hand, never the trip.`;
  if (kind === BRAIN_SWAP) return `The agent's brain is now the model it trained: ${name}${typeof data.topic === "string" ? `, obsessed with ${data.topic}` : ""}, running in this tab. A fresh conversation: it has not seen the trip.`;
  if (kind === BRAIN_DECISION) {
    const who = typeof data.answering === "string" ? data.answering : data.brain === "tab-local" ? "the model in this tab" : "the cloud model";
    const sure = typeof data.confidence === "number" ? ` (${data.decidedBy === "jev" ? "Jev " : ""}${Math.round(data.confidence * 100)}%)` : "";
    return `${who} answers this one: ${typeof data.reason === "string" ? data.reason : "decided"}${sure}.`;
  }
  if (kind === BRAIN_CHECKIN) return `Checked in: this run is back on the server${typeof data.files === "number" ? `, with ${data.files} file${data.files === 1 ? "" : "s"} written offline` : ""}. The same conversation goes on, answered by the cloud model.`;
  if (kind === BRAIN_MOVE) return typeof data.text === "string" ? data.text : "The agent is moving; the model it trained stays in the tab.";
  return `The trained model did not load: ${typeof data.reason === "string" ? data.reason : "unknown reason"}. The agent keeps its brain.`;
}
