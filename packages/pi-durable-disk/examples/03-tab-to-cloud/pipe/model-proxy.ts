// Model calls on behalf of a run, wherever its agent runs (a tab through the pipe, a cloud host through its link): the
// request goes to the model endpoint with the server's own credentials, under the one model the demo allows, and the
// streamed answer goes back as it arrives. The run's token budget is counted from the usage the stream reports. Two
// shapes: OpenAI-compatible (`responses`, `chat/completions`) and Anthropic Messages (`messages`, for a Claude model).
import { MODEL_PATHS, modelHeaders } from "../wire.ts";

export interface ModelOptions {
  /** The endpoint's base URL (`.../v1`): OpenAI-compatible, and for a Claude model the same `.../v1` serves `messages` (a credential broker, or Anthropic). */
  readonly baseUrl: string;
  /** The only model a run may name; the request's `model` is replaced by it. */
  readonly model: string;
  /** Total tokens (prompt + completion) one run may spend. */
  readonly budgetTokens: number;
  /** Fields merged into every request body. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** The endpoint's credential, sent as a bearer token (as `x-api-key` on `messages`); none for an endpoint that takes none (a local broker). Never logged. */
  readonly apiKey?: string;
}

export interface ModelSink {
  head(status: number): void;
  chunk(text: string): void;
  end(status: number, error?: string): void;
}

export class ModelProxy {
  readonly options: ModelOptions;
  spent: number;
  /** Input and output tokens over every call, for the spend line. */
  input = 0;
  output = 0;
  log: (event: string, data?: Record<string, unknown>) => void;

  constructor(options: ModelOptions, spent = 0, log: (event: string, data?: Record<string, unknown>) => void = () => undefined) {
    this.options = options;
    this.spent = spent;
    this.log = log;
  }

  /** Forward one request; the sink gets the status, the body as it streams, and the end. Never throws. `headers`: the MODEL_HEADERS the call named (others are dropped). */
  async forward(path: string, body: Record<string, unknown>, sink: ModelSink, signal: AbortSignal, headers?: Record<string, string>): Promise<void> {
    if (!(MODEL_PATHS as readonly string[]).includes(path)) {
      sink.end(404, `no model endpoint ${JSON.stringify(path)}`);
      return;
    }
    if (this.spent >= this.options.budgetTokens) {
      sink.end(429, `the run spent its budget of ${this.options.budgetTokens} tokens`);
      return;
    }
    const request: Record<string, unknown> = { ...body, ...this.options.extra, model: this.options.model, stream: true };
    if (path === "chat/completions") request.stream_options = { include_usage: true };
    const anthropic = path === "messages";
    const passed = anthropic ? modelHeaders(headers) : undefined;
    const auth: Record<string, string> = this.options.apiKey ? (anthropic ? { "x-api-key": this.options.apiKey } : { authorization: `Bearer ${this.options.apiKey}` }) : {};
    // Anthropic Messages: the call's version (default the one pi-ai's client sends) and the beta features its body uses.
    const versioned: Record<string, string> = anthropic ? { "anthropic-version": passed?.["anthropic-version"] ?? "2023-06-01", ...(passed?.["anthropic-beta"] ? { "anthropic-beta": passed["anthropic-beta"] } : {}) } : {};
    // Anthropic reports usage in parts: the input (with the cache's reads and writes) at message_start, the output so far at each message_delta.
    const claude = { input: 0, output: 0, seen: false };
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versioned, ...auth },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.body) {
        sink.end(response.status, "no body");
        return;
      }
      sink.head(response.status);
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        pending += text;
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            type Usage = { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
            const event = JSON.parse(data) as { usage?: Usage; response?: { usage?: Usage }; message?: { usage?: Usage }; type?: string };
            if (anthropic) {
              const u = event.type === "message_start" ? event.message?.usage : event.type === "message_delta" ? event.usage : undefined;
              if (u) {
                claude.seen = true;
                if (u.input_tokens !== undefined) claude.input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
                if (u.output_tokens !== undefined) claude.output = u.output_tokens;
              }
              continue;
            }
            // Chat completions report usage in a last chunk; the Responses API in its `response.completed` event.
            const usage = event.usage ?? (event.type === "response.completed" ? event.response?.usage : undefined);
            if (usage?.total_tokens) {
              this.spent += usage.total_tokens;
              this.input += usage.input_tokens ?? usage.prompt_tokens ?? 0;
              this.output += usage.output_tokens ?? usage.completion_tokens ?? 0;
              this.log("model.usage", { path, input: usage.input_tokens ?? usage.prompt_tokens ?? 0, output: usage.output_tokens ?? usage.completion_tokens ?? 0, spent: this.spent, totalInput: this.input, totalOutput: this.output });
            }
          } catch {
            // Not JSON: passed through as is.
          }
        }
        sink.chunk(text);
      }
      if (claude.seen) {
        this.spent += claude.input + claude.output;
        this.input += claude.input;
        this.output += claude.output;
        this.log("model.usage", { path, input: claude.input, output: claude.output, spent: this.spent, totalInput: this.input, totalOutput: this.output });
      }
      if (response.status >= 400) this.log("model.error", { status: response.status, body: pending.slice(0, 500) });
      sink.end(response.status);
    } catch (error) {
      sink.end(signal.aborted ? 499 : 502, (error as Error).message);
    }
  }
}
