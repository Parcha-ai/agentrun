# Security and execution boundaries

AgentRun executes trusted workflows. Code nodes and semantic validation probes can execute JavaScript with process privileges. A workflow is not safe merely because it is JSON or passes validation. Isolate untrusted authors and code in a boundary controlled by your application.

Adapters and tools own credential handling, permitted actions, file access, network access, and cancellation of external work. The core cannot undo an effect. Do not blindly retry an effect whose outcome is unknown. Treat input state, candidate files, traces, and raw judgment evidence as application data.

Report vulnerabilities through GitHub's [private reporting form](https://github.com/Parcha-ai/agentrun/security/advisories/new). Include the package version, a minimal reproduction, and the expected and observed behavior. Use fictional data and omit credentials.

The form requires a public repository with private vulnerability reporting enabled. If it is unavailable, [request a private security contact](https://github.com/Parcha-ai/agentrun/issues/new?title=Private%20security%20contact%20request) without describing the vulnerability. Wait for a private channel before sharing details; do not put sensitive reproductions in public issues.

This beta has no production support guarantee. Maintainers must verify the reporting form as part of the [public launch checklist](docs/releasing.md#public-launch).
