---
packages: @parcha/agentrun-computer
kind: breaking
---
A library caller of `adbCli()`, or of the phone provider with its `adb` option as a path or left out, must now pass `env` (serve does). Without it, adb starts with no environment at all: a bare `adb` is found only on the default path (`/usr/bin:/bin`). Pass `env`, or give adb's absolute path.
