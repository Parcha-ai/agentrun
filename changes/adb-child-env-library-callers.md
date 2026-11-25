---
packages: @parcha/agentrun-computer
kind: breaking
---
A library caller of the phone harness provider that gives `adb` as a path, or not at all, must now pass `env` with PATH and HOME (serve does). Without it, adb starts with no environment: a bare `adb` is found only on the default path (`/usr/bin:/bin`), and adb finds no home for its keys. Pass `env`, or give `adb` as a transport (`adbCli(path, { env })`).
