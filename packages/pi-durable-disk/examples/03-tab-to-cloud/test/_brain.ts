// Shared by the brain tests: a model "on the disk" (a manifest and chunks), a scripted model, a stand-in for the cloud model.
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Llm } from "../../04-walks-home/tab/src/modelhost.ts";

export const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const MODEL = "gemma-3-1b-it (the Moon)";

export function modelDisk() {
  const bytes = Uint8Array.from({ length: 200 }, (_, i) => (i * 7 + 3) & 255);
  const chunks = [0, 1, 2].map((n) => { const part = bytes.slice(n * 64, n * 64 + 64); return { n, path: `home/model/chunk-${String(n).padStart(4, "0")}.bin`, offset: n * 64, size: part.length, sha256: sha(part) }; });
  const manifest = JSON.stringify({ format: "gguf-chunks-v1", name: MODEL, quant: "Q4_K_M", size: 200, sha256: sha(bytes), chunk_bytes: 64, chunks: [...chunks, { n: 3, path: "home/model/chunk-0003.bin", offset: 192, size: 8, sha256: sha(bytes.slice(192)) }], topic: "the Moon" });
  return { manifest, files: new Map<string, Uint8Array>([...chunks.map((c) => [c.path, bytes.slice(c.offset, c.offset + c.size)] as const), ["home/model/chunk-0003.bin", bytes.slice(192)]]) };
}

/** A scripted model: text per question (the last user message), word by word, honouring abort. */
export function scripted(script: (q: string) => string, delayMs = 0) {
  const seen: { role: string; content: string }[][] = [];
  const loads = { count: 0, exits: 0 };
  const llm: Llm = {
    async load() { loads.count++; },
    async chat({ messages, signal, onText, maxTokens }) {
      seen.push(messages.map((m) => ({ ...m })));
      const full = script(messages.at(-1)!.content);
      let text = "", tokens = 0;
      for (const w of full.split(/(?<= )/)) {
        if (signal.aborted || tokens >= maxTokens) break;
        await new Promise((r) => (delayMs ? setTimeout(r, delayMs) : setImmediate(r)));
        text += w; tokens++; onText(text, tokens);
      }
      return { text, tokens };
    },
    async exit() { loads.exits++; },
  };
  return { llm, seen, loads };
}

export const THOUGHT = "Hm, the question is about rain. The Moon pulls the tides.";
export const ANSWER = "Rain is wet. The Moon agrees.";
export const reply = (q: string) => (q === "Who are you?" ? "<thinking>Who? The Moon.</thinking>\nI am Luna. I glow." : `<thinking>${THOUGHT}</thinking>\n${ANSWER}`);


/** The cloud model that did the trip: answers a fixed line, and records what it was shown (a system prompt and tools, as the agent has them). */
export function cloudProvider(seen: unknown[][] = []) {
  const stream = (model: any, context: any) => {
    seen.push(context.messages);
    const s = createAssistantMessageEventStream();
    const message: any = { role: "assistant", content: [{ type: "text", text: "Cloud agent: trained, moving home." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => { s.push({ type: "start", partial: message }); s.push({ type: "done", reason: "stop", message }); s.end(); });
    return s;
  };
  return createProvider({
    id: "pipe", name: "cloud", auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: "x" } }) } },
    models: [{ id: "cloud-big", name: "cloud-big", api: "openai-responses", provider: "pipe", baseUrl: "x", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }],
    api: { stream, streamSimple: stream } as never,
  });
}
