---
packages: repo
kind: ci
---
CI compiles the import CLI (`packages/import/src/cli.ts`, the `agentrun-import` bin) into a single binary with Bun, on Linux x64, Linux arm64 and macOS arm64, runs each on a made-up home, and keeps it as an artifact named `agentrun-import-<os>-<arch>`. The test checks the binary's `--known-answer` lines byte for byte against Node running the CLI built by `tsc`, and its exit 2 on a usage error. Node stays the runtime the packages ship on.
`node scripts/build-binary.mjs [--entry FILE] [--target bun-<os>-<arch>]...` builds it locally with the Bun `.bun-version` pins; it needs `npm ci --workspace=packages/import --include-workspace-root` first, since the entry prices requests with pi-ai's catalog and a binary built without it prices nothing. It refuses an entry that imports `node:sqlite` where it loads (Bun has none; import `bun:sqlite` in a branch for Bun), and the binary reads no `.env` or `bunfig.toml` from the directory it runs in.
