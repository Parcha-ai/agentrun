---
packages: @parcha/agentrun-jev
kind: feature
---
**`@parcha/agentrun-jev`: images and Box questions, on `@typesafe-ai/sdk` 0.7.0**
- `createJevRunner` takes images (`assets`: a reference to PNG or JPEG file bytes and their type, the reference written in the state or a question) and Box questions (Jev 1.14). It sends `TypeSafe-Danger-Zone-Images: true` on every request that carries an image or a Box and on no other, as a multipart request. Priced, receipted and retried as text is; `request_sha256` names each image by its own digest.
- Refused before any request: a Box on a model that does not answer it (name `jev-1.14.0`; the default `jev-latest` is 1.13), a Box with no image, a file that is not PNG or JPEG or is over 16 MiB, a reference nothing uses, and, for `provider: "openrouter"`, anything that carries an image or a Box. `model` can be named per call.
- New types `JevJudge` (what `createJevRunner` returns), `JevJudgeParams`, `JevJudgeResult` and `JevImage`: the port a host hands to a package that asks Jev about images without importing the SDK.
- `@typesafe-ai/sdk` 0.6.0 to 0.7.0. The SDK now compresses request bodies with zstd by default; the runner turns that off, so bodies are the uncompressed JSON they were.
