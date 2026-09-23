# Security and execution boundaries

AgentRun executes trusted workflows. Code nodes and semantic validation probes can execute JavaScript with process privileges. A workflow is not safe merely because it is JSON or passes validation. Isolate untrusted authors and code in a boundary controlled by your application.

Adapters and tools own credential handling, permitted actions, file access, network access, and cancellation of external work. The core cannot undo an effect. Do not blindly retry an effect whose outcome is unknown. Treat input state, candidate files, traces, and raw judgment evidence as application data.

The public repository and private vulnerability-reporting route must be configured before release. Until then, do not post vulnerabilities or sensitive reproductions to public issue trackers. The candidate has no production support guarantee.
