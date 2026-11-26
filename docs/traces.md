# Send run traces to Sentry or any OpenTelemetry backend

AgentRun's server can export a trace of every run on a pi or CLI harness over OTLP/HTTP: an `invoke_agent` span for
the run, a `chat` span per model request with its tokens, and an `execute_tool` span per tool call. The spans follow the OpenTelemetry GenAI
semantic conventions ([v0.1.0][genai]), so any backend that reads those shows a run's model calls, tool calls, tokens
and cost with no SDK of its own in the run. This page sets it up for Sentry, and for any other backend through an
OpenTelemetry Collector. What the trace holds and the variables it takes are in
[AgentRun Server](../packages/serve/README.md#traces-opentelemetry).

Tracing is off until an OTLP endpoint is set. Set the variables where the server (and any runner) starts. No run ever
receives them: no `OTEL_*` variable reaches a run's harness, tools or computer, so the auth header stays out of the box.

## Sentry

Sentry takes OTLP traces directly ([Sentry: OTLP traces][sentry-otlp]). In Sentry, open your project's
**Settings → Client Keys (DSN) → OpenTelemetry (OTLP)**. It shows the OTLP endpoint and the auth header. Set two
variables:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT="<your-sentry-otlp-endpoint>"
OTEL_EXPORTER_OTLP_HEADERS="x-sentry-auth=sentry sentry_key=<your-public-key>"
```

`<your-sentry-otlp-endpoint>` is the combined OTLP endpoint, of the form
`https://o<org-id>.ingest.sentry.io/api/<project-id>/integration/otlp`; the exporter adds `/v1/traces`. Sentry's own
page names the traces-only variables instead, and those work as written: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` set to
the traces endpoint (the one ending in `/integration/otlp/v1/traces`, taken as given) and
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` set to the same header. The header value may also be percent-encoded
(`sentry%20sentry_key=...`), as the [OTLP exporter spec][otlp-env] writes header values.

Then open **Explore → Agents** in Sentry ([Sentry: Agents][sentry-agents]):

- **Agents**: every span carries `gen_ai.agent.name`, the agent's name as you gave it, and `gen_ai.agent.id`, its id
  ([GenAI agent spans][genai-agent]), so a run is listed under the agent that ran. The harness that ran it is
  `agentrun.harness`.
- **Traces**: one trace per run. Its root is `invoke_agent {agent name}`; under it, `chat {model}` for each model request
  and `execute_tool {tool}` for each tool call, in order, each with its duration and any error. A run that a runner
  took up again (a resume) has one `invoke_agent` span per claim, all in the same trace.
- **LLM Calls**: each `chat` span with its provider, model and tokens: `gen_ai.usage.input_tokens` (the whole input,
  cache included), `gen_ai.usage.cache_read.input_tokens`, the cache write, and `gen_ai.usage.output_tokens`.
- **Cost**: Sentry prices each `chat` span from its tokens and model when its price list knows the model
  ([Sentry: model costs][sentry-costs]); an unknown model costs 0 there. A request billed to a plan, and every turn of a
  plan harness, has `agentrun.billing=plan` and no token counts, so Sentry gives it no cost.
- **Conversations**: spans grouped by `gen_ai.conversation.id`, which is the run id. Content is off: no span holds a
  prompt, a message, or a tool's arguments or result, so a conversation shows its calls and no transcript.

Two attributes Sentry reads are filled in by Sentry rather than sent:

- `gen_ai.response.model` is not set. Sentry uses `gen_ai.request.model` in its place
  ([Relay][relay-model]).
- The cache write goes under both names: `gen_ai.usage.cache_write.input_tokens` (OpenTelemetry's) and
  `gen_ai.usage.cache_creation.input_tokens` (the one Sentry's cost reads, [Relay][relay-cost]). Sentry prices the
  uncached input as `input_tokens - cache_read - cache_creation` ([Relay][relay-raw]), which is why `input_tokens`
  includes the cache for every provider, Anthropic's too.

Reasoning tokens are not on chat spans yet.

## Any other backend, through a Collector

Point the server at an [OpenTelemetry Collector][collector] and let the Collector forward to your backend. A minimal
Collector config, with an OTLP receiver and an `otlphttp` exporter:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  otlphttp:
    endpoint: <your-backend-otlp-endpoint>
    headers:
      <your-auth-header>: <your-auth-value>

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp]
```

Then set `OTEL_EXPORTER_OTLP_ENDPOINT="http://<collector-host>:4318"` where the server starts. The `otlphttp` exporter
adds `/v1/traces` to `endpoint`; for a backend that gives a full traces URL, set `traces_endpoint` to it instead
([otlphttp exporter][otlphttp]). A Collector also forwards to Sentry: use its OTLP endpoint and the `x-sentry-auth`
header there ([Sentry: Collector][sentry-collector]).

## How spans leave

Spans are sent in the background, so a run's end never waits on the collector or backend. A server or runner that stops
waits at most 3 s to send what is left. A runner with tracing on says so in its log as it starts, with the endpoint's
origin alone: scheme, host and port, never its user, password, path, query, fragment or headers. A backend that is
down costs the dropped spans and a log line with that origin and the time, then at most one line a minute counting the
failed exports since the last; the run is not affected. A run is sampled whole or not at all (`OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`), so a trace is never
missing part of its run. `OTEL_SDK_DISABLED=true` turns tracing off even with an endpoint set.

[genai]: https://github.com/open-telemetry/semantic-conventions-genai/releases/tag/v0.1.0
[genai-agent]: https://github.com/open-telemetry/semantic-conventions-genai/blob/d0e74ba6c48bcc4ded473b1828a8212f06b23753/docs/gen-ai/gen-ai-agent-spans.md#L213-L272
[otlp-env]: https://github.com/open-telemetry/opentelemetry-specification/blob/v1.62.0/specification/protocol/exporter.md
[sentry-otlp]: https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/concepts/otlp/direct/traces.mdx
[sentry-agents]: https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/product/agents/index.mdx
[sentry-costs]: https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/product/agents/costs.mdx
[sentry-collector]: https://github.com/getsentry/sentry-docs/blob/fba2d1a3c4cf875cf51395a981e0e561880f1e8f/docs/concepts/otlp/forwarding/pipelines/collector.mdx
[relay-model]: https://github.com/getsentry/relay/blob/b95381eca6c2d794bf9b13afce6f48bd02c2cfe3/relay-event-normalization/src/eap/ai.rs#L59-L71
[relay-cost]: https://github.com/getsentry/relay/blob/b95381eca6c2d794bf9b13afce6f48bd02c2cfe3/relay-event-normalization/src/eap/ai.rs#L193-L199
[relay-raw]: https://github.com/getsentry/relay/blob/b95381eca6c2d794bf9b13afce6f48bd02c2cfe3/relay-event-normalization/src/normalize/span/ai.rs#L57-L64
[collector]: https://opentelemetry.io/docs/collector/
[otlphttp]: https://github.com/open-telemetry/opentelemetry-collector/blob/d56d0a1c98b680549fed9c595c731cb26a473f3b/exporter/otlphttpexporter/README.md
