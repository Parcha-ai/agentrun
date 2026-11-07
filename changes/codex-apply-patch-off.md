---
packages: @parcha/agentrun-harness-codex
kind: fix
---
With the built-ins off, a code-mode model (luna, sol) is no longer offered Codex's own `apply_patch`. Code mode listed it as a nested tool of `exec` with no environment to run it, so every call failed with "No usable execution environment is available". The harness now hands Codex its own bundled model catalog with `apply_patch_tool_type` set to null (`model_catalog_json`). `model_catalog_json` is now reserved: an app's `config` may not set it. With `builtins: true`, `apply_patch` stays. If the binary gives no catalog, the session runs on Codex's own and says so: the sandbox note the model gets with its first message reads "Codex's own apply_patch stays listed: …" with the reason.

A host tool's images now reach a Codex model as images. The tool's answer to Codex carries each one as an `inputImage` item (a data: URL) after its text, where before only the text went.
