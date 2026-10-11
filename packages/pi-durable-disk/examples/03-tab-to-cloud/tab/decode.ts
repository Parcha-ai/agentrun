// One model turn from the small model, decoded the same way in the tab (over wllama) and in scoring (over llama-server).
// Grammar-locked: the decoder opens the thinking and caps it, the model writes freely until it opens a call, and the call
// body is decoded under callGrammar(). Free: one plain generation. toPiContent() turns the result into pi's assistant
// blocks. Portable: no Node API.

import {
  CALL_OPEN, THINK_CLOSE, THINK_OPEN, callGrammar, parseModelTurn, type ParsedTurn, type TextBlock, type ThinkingBlock,
  type ToolCallBlock, type ToolSpec, TOOLS,
} from "./tool-format.ts";

export interface CompleteRequest {
  prompt: string;
  maxTokens: number;
  stop?: string[];
  grammar?: string;
}

export interface CompleteResult {
  text: string;
  /** "eog": the model ended its turn; "stop": a stop string (not included in text); "length": maxTokens. */
  stoppedBy: "eog" | "stop" | "length";
  /** Prompt tokens the backend evaluated (not served from its cache) and tokens generated. */
  promptTokens: number;
  outputTokens: number;
}

export interface Backend {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export interface DecodeOptions {
  mode: "grammar" | "free";
  /** Grammar mode: the thinking is closed after this many tokens. */
  thinkTokens: number;
  /** The answer, or the text before a call. */
  answerTokens: number;
  /** The call body. */
  callTokens: number;
  tools?: readonly ToolSpec[];
}

export interface DecodedTurn {
  /** The turn as the model wrote it (with the parts the decoder supplied: <thinking>, a forced </thinking>). */
  raw: string;
  parsed: ParsedTurn;
  /** Grammar mode: the thinking hit its cap and was closed by the decoder. */
  thinkingCut: boolean;
  /** The answer or the call hit its token cap. */
  cut: boolean;
  promptTokens: number;
  outputTokens: number;
  /** Grammar mode: the tokens spent inside the thinking (free mode: not measured, -1). */
  thinkTokens: number;
  calls: number;
}

export async function decodeTurn(backend: Backend, prompt: string, o: DecodeOptions): Promise<DecodedTurn> {
  const tools = o.tools ?? TOOLS;
  let promptTokens = 0, outputTokens = 0, calls = 0;
  const run = async (req: CompleteRequest) => {
    const r = await backend.complete(req);
    promptTokens += r.promptTokens;
    outputTokens += r.outputTokens;
    calls++;
    return r;
  };
  if (o.mode === "free") {
    const r = await run({ prompt, maxTokens: o.thinkTokens + o.answerTokens + o.callTokens });
    return { raw: r.text, parsed: parseModelTurn(r.text), thinkingCut: false, cut: r.stoppedBy === "length", promptTokens, outputTokens, thinkTokens: -1, calls };
  }
  let raw = THINK_OPEN;
  const think = await run({ prompt: prompt + raw, maxTokens: o.thinkTokens, stop: [THINK_CLOSE] });
  raw += think.text;
  const thinkTokens = think.outputTokens;
  if (think.stoppedBy === "eog") {
    // The turn ended inside the thinking: an empty answer.
    return { raw, parsed: parseModelTurn(raw + THINK_CLOSE), thinkingCut: false, cut: false, promptTokens, outputTokens, thinkTokens, calls };
  }
  const thinkingCut = think.stoppedBy === "length";
  raw += `${THINK_CLOSE}\n`;
  const said = await run({ prompt: prompt + raw, maxTokens: o.answerTokens, stop: [CALL_OPEN] });
  raw += said.text;
  if (said.stoppedBy !== "stop") {
    return { raw, parsed: parseModelTurn(raw), thinkingCut, cut: said.stoppedBy === "length", promptTokens, outputTokens, thinkTokens, calls };
  }
  raw += CALL_OPEN;
  const body = await run({ prompt: prompt + raw, maxTokens: o.callTokens, grammar: callGrammar(tools) });
  raw += body.text;
  return { raw, parsed: parseModelTurn(raw), thinkingCut, cut: body.stoppedBy === "length", promptTokens, outputTokens, thinkTokens, calls };
}

/**
 * A decoded turn as pi's assistant content: the thinking block, then the call or the answer text. A call whose JSON
 * parsed goes to pi even when pi will refuse it (an unknown tool, bad arguments), so pi's own error comes back to the
 * model as it would anywhere; a call that did not parse ends the turn as text.
 */
export function toPiContent(p: ParsedTurn, callId: string): { content: (ThinkingBlock | ToolCallBlock | TextBlock)[]; stopReason: "stop" | "toolUse" } {
  const thinking: ThinkingBlock = { type: "thinking", thinking: p.thinking };
  let call: { name?: unknown; arguments?: unknown } | undefined = p.call;
  if (!call && p.problem && (p.problem.kind === "unknown-tool" || p.problem.kind === "bad-args")) {
    try { call = JSON.parse(p.problem.raw); } catch { call = undefined; }
  }
  if (call && typeof call.name === "string") {
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? (call.arguments as Record<string, unknown>) : {};
    return { content: [thinking, { type: "toolCall", id: callId, name: call.name, arguments: args }], stopReason: "toolUse" };
  }
  return { content: [thinking, { type: "text", text: p.problem ? `${p.answer}${p.problem.raw}` : p.answer }], stopReason: "stop" };
}

/** llama.cpp's llama-server /completion as a backend. */
export function llamaServer(url: string, sampling: Record<string, unknown>): Backend {
  return {
    async complete(req) {
      const res = await fetch(`${url}/completion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...sampling, prompt: req.prompt, n_predict: req.maxTokens, stop: req.stop ?? [], cache_prompt: true,
          ...(req.grammar ? { grammar: req.grammar } : {}),
        }),
      });
      if (!res.ok) throw new Error(`llama-server ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = (await res.json()) as { content: string; stop_type?: string; tokens_predicted?: number; timings?: { prompt_n?: number; predicted_n?: number } };
      const stoppedBy = j.stop_type === "word" ? "stop" : j.stop_type === "limit" ? "length" : "eog";
      return { text: j.content, stoppedBy, promptTokens: j.timings?.prompt_n ?? 0, outputTokens: j.timings?.predicted_n ?? j.tokens_predicted ?? 0 };
    },
  };
}
