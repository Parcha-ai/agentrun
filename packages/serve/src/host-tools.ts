// The file tools of a run on a harness other than pi: pi's own read, write and edit (ArchilCodingTools), called with
// the run's environment, so their arguments, their confinement to the run's work/ and their refusals are pi's, word for
// word. pi's tools take only the environment, their output and their diagnostics from a call's API, so that is all a
// call here gives them. read may run again after a crash; write and edit never: the kernel records each one's intent
// before it runs, and a call a crash cut off is answered interrupted, not run again.
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HostTool } from "@parcha/agentrun-adapters";
import { ArchilCodingTools, type DurableRun } from "@parcha/pi-durable-disk";

export const REPLAY: Record<string, "safe" | "never"> = { read: "safe", write: "never", edit: "never" };

/** One call's result, kept by its call id for the run's timeline (an adapter's tool_end carries none). */
export type ToolResults = Map<string, { text: string; isError: boolean }>;

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("") : "";

export function fileTools(run: DurableRun, names: readonly string[], context: Context, results: ToolResults): HostTool[] {
  const tools = new Map((ArchilCodingTools.tools ?? []).map((tool) => [tool.name, tool as ToolRegistration] as const));
  return names.flatMap((name) => {
    const tool = tools.get(name);
    const replay = REPLAY[name];
    if (!tool || !replay) return [];
    const host: HostTool = {
      name,
      description: tool.description,
      inputSchema: tool.parameters as unknown as Record<string, unknown>,
      replay,
      async call(args, { callId, signal }) {
        const out: string[] = [];
        const env = await run.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context);
        const api = { env, output: (chunk: string | Uint8Array) => void out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")), outputWindow: undefined, diagnostic: () => {} };
        const result = await tool.execute(args as never, api as never, withAbortSignal(signal, context)).catch((error: Error) => ({ content: [{ type: "text", text: error.message }], isError: true }));
        const answer = { text: textOf(result.content) || out.join(""), isError: result.isError === true };
        results.set(callId, answer);
        return answer;
      },
    };
    return [host];
  });
}
