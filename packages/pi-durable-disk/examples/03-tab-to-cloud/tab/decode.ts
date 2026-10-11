// One model turn from the small model, decoded the same way in the tab (over wllama) and in scoring (over llama-server).
// Grammar-locked: the decoder opens the thinking and caps it, the model writes freely until it opens a call, and the call
// body is decoded under callGrammar(). Free: one plain generation. Lazy: the same turn in ONE completion (the grammar engages
// on the "<tool_call>" trigger; the caps are token limits on the stream). toPiContent() turns the result into pi's assistant
// blocks. Portable: no Node API.

import {
  CALL_CLOSE, CALL_OPEN, isWholeJson, THINK_CLOSE, THINK_OPEN, callGrammar, parseModelTurn, type ParsedTurn, type TextBlock, type ThinkingBlock,
  type ToolCallBlock, type ToolSpec, TOOLS,
} from "./tool-format.ts";
import { LimitTracker, type Limit } from "./limits.ts";
export { LimitTracker, type Limit };

export interface CompleteRequest {
  prompt: string;
  maxTokens: number;
  stop?: string[];
  grammar?: string;
  /** With `grammar`: the grammar engages only once `trigger` has been generated; the grammar's root then starts with the trigger (callGrammar(tools, {withOpen: true})). */
  lazy?: { trigger: string };
  /** Token limits on the stream (limits.ts): a generation that runs one out is stopped and returns stoppedBy "length" with `capped` = the limit's index. */
  limits?: readonly Limit[];
}

export interface CompleteResult {
  text: string;
  /** "eog": the model ended its turn; "stop": a stop string (not included in text); "length": maxTokens. */
  stoppedBy: "eog" | "stop" | "length";
  /** Prompt tokens the backend evaluated (not served from its cache; -1 when it could not say) and tokens generated. */
  promptTokens: number;
  outputTokens: number;
  /** The index of the `limits` entry that stopped the generation. */
  capped?: number;
}

export interface Backend {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export interface DecodeOptions {
  /** "grammar": three completions (capped thinking, text until a call, the call under the grammar). "lazy": one (two when the thinking is cut). "free": one plain generation. */
  mode: "grammar" | "lazy" | "free";
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
  /** False when a generation was stopped before the server reported its prompt count (promptTokens is then a lower bound). */
  promptKnown: boolean;
  outputTokens: number;
  /** Grammar mode: the tokens spent inside the thinking (free mode: not measured, -1). */
  thinkTokens: number;
  calls: number;
}

export async function decodeTurn(backend: Backend, prompt: string, o: DecodeOptions): Promise<DecodedTurn> {
  const tools = o.tools ?? TOOLS;
  let promptTokens = 0, outputTokens = 0, calls = 0, promptKnown = true;
  const run = async (req: CompleteRequest) => {
    const r = await backend.complete(req);
    // A generation stopped by a limit may not report its prompt count (-1): the turn's count is then a lower bound.
    if (r.promptTokens >= 0) promptTokens += r.promptTokens; else promptKnown = false;
    outputTokens += r.outputTokens;
    calls++;
    return r;
  };
  if (o.mode === "lazy") {
    // ONE completion: the thinking and the text are free under token limits, and the grammar engages on "<tool_call>" and then holds the call to its one byte form.
    const lazy = { trigger: CALL_OPEN };
    const grammar = callGrammar(tools, { withOpen: true });
    let raw = THINK_OPEN;
    const first = await run({ prompt: prompt + raw, maxTokens: o.thinkTokens + o.answerTokens + o.callTokens, grammar, lazy, limits: [{ start: null, end: THINK_CLOSE, tokens: o.thinkTokens }, { start: THINK_CLOSE, end: CALL_OPEN, tokens: o.answerTokens + 1 /* the newline the format puts after </thinking> is one token of its own, and the three-completion path forces it before the cap starts */ }, { start: CALL_OPEN, end: CALL_CLOSE, tokens: o.callTokens, accept: isWholeJson }] });
    if (first.capped !== 0) {
      raw += first.text;
      const cut = first.capped === 1 || first.capped === 2 || first.stoppedBy === "length";
      // the turn ended inside the thinking (no </thinking> and no call): an empty answer, as the three-completion path reads it
      if (first.stoppedBy === "eog" && !first.text.includes(THINK_CLOSE)) {
        return { raw, parsed: parseModelTurn(raw + THINK_CLOSE), thinkingCut: false, cut: false, promptTokens, promptKnown, outputTokens, thinkTokens: Math.min(first.outputTokens, o.thinkTokens), calls };
      }
      return { raw, parsed: parseModelTurn(raw), thinkingCut: false, cut, promptTokens, promptKnown, outputTokens, thinkTokens: thinkTokensOf(first.text, first.outputTokens), calls };
    }
    // the thinking ran out its cap: it is closed here and the rest of the turn is one more lazy completion
    raw += `${first.text}${THINK_CLOSE}\n`;
    const rest = await run({ prompt: prompt + raw, maxTokens: o.answerTokens + o.callTokens, grammar, lazy, limits: [{ start: null, end: CALL_OPEN, tokens: o.answerTokens }, { start: CALL_OPEN, end: CALL_CLOSE, tokens: o.callTokens, accept: isWholeJson }] });
    raw += rest.text;
    return { raw, parsed: parseModelTurn(raw), thinkingCut: true, cut: rest.capped === 0 || rest.capped === 1 || rest.stoppedBy === "length", promptTokens, promptKnown, outputTokens, thinkTokens: first.outputTokens, calls };
  }
  if (o.mode === "free") {
    const r = await run({ prompt, maxTokens: o.thinkTokens + o.answerTokens + o.callTokens });
    return { raw: r.text, parsed: parseModelTurn(r.text), thinkingCut: false, cut: r.stoppedBy === "length", promptTokens, promptKnown, outputTokens, thinkTokens: -1, calls };
  }
  let raw = THINK_OPEN;
  const think = await run({ prompt: prompt + raw, maxTokens: o.thinkTokens, stop: [THINK_CLOSE] });
  raw += think.text;
  const thinkTokens = think.outputTokens;
  if (think.stoppedBy === "eog") {
    // The turn ended inside the thinking: an empty answer.
    return { raw, parsed: parseModelTurn(raw + THINK_CLOSE), thinkingCut: false, cut: false, promptTokens, promptKnown, outputTokens, thinkTokens, calls };
  }
  const thinkingCut = think.stoppedBy === "length";
  raw += `${THINK_CLOSE}\n`;
  const said = await run({ prompt: prompt + raw, maxTokens: o.answerTokens, stop: [CALL_OPEN] });
  raw += said.text;
  if (said.stoppedBy !== "stop") {
    return { raw, parsed: parseModelTurn(raw), thinkingCut, cut: said.stoppedBy === "length", promptTokens, promptKnown, outputTokens, thinkTokens, calls };
  }
  raw += CALL_OPEN;
  const body = await run({ prompt: prompt + raw, maxTokens: o.callTokens, grammar: callGrammar(tools) });
  raw += body.text;
  return { raw, parsed: parseModelTurn(raw), thinkingCut, cut: body.stoppedBy === "length", promptTokens, promptKnown, outputTokens, thinkTokens, calls };
}

/** The tokens spent in the thinking when one completion covers the whole turn: the share of the output up to "</thinking>" (a token count by proportion of characters; the exact count is not reported per phase). */
function thinkTokensOf(text: string, outputTokens: number): number {
  const at = text.indexOf(THINK_CLOSE);
  return at < 0 || text.length === 0 ? outputTokens : Math.max(1, Math.round((at / text.length) * outputTokens));
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

/**
 * llama.cpp's llama-server /completion as a backend. A request with `lazy` or `limits` is streamed (server-sent events, one token per event): the grammar is sent lazy
 * (grammar_lazy + a word trigger) and the limits are enforced here by reading the stream, exactly as the tab's wllama backend does, so a turn is cut at the same place in both.
 */
export function llamaServer(url: string, sampling: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Backend {
  return {
    async complete(req) {
      const streaming = req.limits !== undefined || req.lazy !== undefined;
      const res = await fetchImpl(`${url}/completion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...sampling, prompt: req.prompt, n_predict: req.maxTokens, stop: req.stop ?? [], cache_prompt: true,
          ...(req.grammar ? { grammar: req.grammar } : {}),
          ...(req.grammar && req.lazy ? { grammar_lazy: true, grammar_triggers: [{ type: 1, value: req.lazy.trigger }] } : {}),
          ...(streaming ? { stream: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(`llama-server ${res.status}: ${(await res.text()).slice(0, 300)}`);
      if (!streaming) {
        const j = (await res.json()) as { content: string; stop_type?: string; tokens_predicted?: number; timings?: { prompt_n?: number; predicted_n?: number } };
        const stoppedBy = j.stop_type === "word" ? "stop" : j.stop_type === "limit" ? "length" : "eog";
        return { text: j.content, stoppedBy, promptTokens: j.timings?.prompt_n ?? 0, outputTokens: j.timings?.predicted_n ?? j.tokens_predicted ?? 0 };
      }
      const tracker = new LimitTracker(req.limits);
      let text = "", tokens = 0, capped = -1, stopType = "", promptTokens = 0, predicted = 0;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      read: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const j = JSON.parse(line.slice(5)) as { content?: string; stop?: boolean; stop_type?: string; tokens_predicted?: number; timings?: { prompt_n?: number; predicted_n?: number } };
          if (j.content) { text += j.content; tokens++; }
          if (j.stop) { stopType = j.stop_type ?? ""; promptTokens = j.timings?.prompt_n ?? 0; predicted = j.timings?.predicted_n ?? j.tokens_predicted ?? 0; break read; }
          capped = tracker.push(text, tokens);
          if (capped >= 0) { await reader.cancel().catch(() => undefined); break read; }
        }
      }
      const outputTokens = predicted || tokens;
      // A capped stream is cancelled before the server's final event, which carries the prompt count: unknown, not 0.
      if (capped >= 0) return { text, stoppedBy: "length", capped, promptTokens: -1, outputTokens };
      return { text, stoppedBy: stopType === "word" ? "stop" : stopType === "limit" ? "length" : "eog", promptTokens, outputTokens };
    },
  };
}
