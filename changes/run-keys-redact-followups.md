---
packages: @parcha/agentrun-serve
kind: breaking
---
A harness module's runner gets the run's redactor on its launch (`HarnessLaunch.redact`, required and typed) and no longer among the harness's own options, and every loop the runner makes refuses to start without the runner's redactor that holds keys. Upgrading: a harness module reads the run's redactor from `launch.redact` (required); `extra.redact` is no longer set.
- A native run's loop, the runner's dispatch loop, a loop the live view wraps and a loop for a run in its own process now each refuse to start without the runner's held redactor, as the adapter, SDK and workflow loops already did. In 0.1.0-beta.58 a native run's loop given none ran on a redactor of the runner's environment alone, which holds no key a claim opens; the runner always hands its own, so only a caller outside the runner reached that.
