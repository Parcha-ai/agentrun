// Model calls on behalf of a run, wherever its agent runs (a tab through the pipe, a cloud host through its link): the
// request goes to the model endpoint with the server's own credentials, under the one model the demo allows, and the
// streamed answer goes back as it arrives. The run's token budget is counted from the usage the stream reports.
import { MODEL_PATHS } from "../wire.ts";

export interface ModelOptions {
  /** OpenAI-compatible base URL (`.../v1`). */
  readonly baseUrl: string;
  /** The only model a run may name; the request's `model` is replaced by it. */
  readonly model: string;
  /** Total tokens (prompt + completion) one run may spend. */
  readonly budgetTokens: number;
  /** Fields merged into every request body. */
  readonly extra?: Readonly<Record<string, unknown>>;
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

  /** Forward one request; the sink gets the status, the body as it streams, and the end. Never throws. */
  async forward(path: string, body: Record<string, unknown>, sink: ModelSink, signal: AbortSignal): Promise<void> {
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
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
            type Usage = { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
            const event = JSON.parse(data) as { usage?: Usage; response?: { usage?: Usage }; type?: string };
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
      if (response.status >= 400) this.log("model.error", { status: response.status, body: pending.slice(0, 500) });
      sink.end(response.status);
    } catch (error) {
      sink.end(signal.aborted ? 499 : 502, (error as Error).message);
    }
  }
}
