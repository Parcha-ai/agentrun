---
packages: @parcha/agentrun-import
kind: feature
---
A totals read (`parseHome`, on its own thread and in the pool) reads a Claude Code or Codex line for the fields its reader takes, straight from the line's bytes: every other value (a tool result, a call's arguments, a command's output, reasoning) is checked as JSON where it lies and never decoded or parsed. A WebAssembly walk built from `packages/import/wasm/scan.rs` does the checking; it travels as base64 in `src/scan-wasm.ts`, so installing or building the package needs no Rust (`node packages/import/wasm/build.mjs` rebuilds it with rustc 1.95.0, which `wasm/rust-toolchain.toml` pins; CI rebuilds it and fails on any byte of difference). A line the walk cannot be sure of (an escaped key, nesting deeper than 1024, a line over 64 MiB) is parsed whole as before, and a line JSON.parse rejects is still passed over. The totals are the same. Other reads, and pi, parse every line whole.
