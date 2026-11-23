---
packages: @parcha/agentrun-serve, @parcha/agentrun-import
kind: feature
---
Set OTEL_EXPORTER_OTLP_ENDPOINT and every run exports a GenAI trace: model calls, tool calls, tokens with cache, no content. Each run on a pi or CLI harness is one trace through the official OpenTelemetry SDK, its spans named by the GenAI semantic conventions (`invoke_agent`, `chat`, `execute_tool`), its token counts on chat spans only, with `gen_ai.usage.input_tokens` inclusive of the cache. Unset, no OpenTelemetry code loads. `@parcha/agentrun-import` adds `otelUsage` (a request's counts as a trace carries them) and an `openrouter` format to `normalizeUsage`.
