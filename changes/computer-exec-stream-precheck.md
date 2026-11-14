---
packages: @parcha/agentrun-computer
kind: breaking
---
`MachineHost.exec` is specified as a live, two-way, byte-exact stream with no timeout, and a new vendor checks its exec first with `npm run conformance -w @parcha/agentrun-computer -- --provider <id | ./module.js> --exec-stream --machine <id> [--quick]`. The pre-check builds the host with the module's `createHost()` and calls `exec` alone: all 256 byte values each way, 8 MiB by sha256, output and stdin while the process runs, stderr apart, the exit code, `kill`, and a silent 75 s process (5 s with `--quick`). Each failure says what the exec did wrong.
- E2B's exec passes bytes through unchanged. It used `commands.run`, whose `onStdout` decodes output as UTF-8 and turns every byte that is not UTF-8 into U+FFFD; it now reads envd's process stream through the SDK's Connect client (`commands.rpc.start`) and passes each event's bytes on.
- Breaking: `E2BSandbox.commands` is now `rpc`, `sendStdin`, `closeStdin` and `kill`, and `E2BCommandHandle`, `E2BCommandResult` and `E2BRunOptions` are gone. A caller that hands `create()` its own `Sandbox` slice gives one with those members; the e2b package's own `Sandbox` already has them.
- PROVIDERS.md says up front what an API needs (a streaming exec and a list by label), makes the exec pre-check step one, and fixes eight places a vendor tripped up.
