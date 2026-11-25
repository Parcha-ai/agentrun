---
packages: @parcha/agentrun-serve
kind: fix
---
A native run's loop, the runner's dispatch loop, a loop the live view wraps and a loop for a run in its own process now each refuse to start without the runner's redactor that holds keys, as the adapter, SDK and workflow loops already did. In 0.1.0-beta.58 a native run's loop given none ran on a redactor of the runner's environment alone, which holds no key a claim opens; the runner always hands its own, so only a caller outside the runner reached that.
- A harness module's runner now gets the runner's redactor as `launch.redact` (`HarnessLaunch`), typed and always present, instead of an untyped `redact` among the `extra` options. A module that read `extra.redact` reads `launch.redact` instead.
