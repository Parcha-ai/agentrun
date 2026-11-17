---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
SDK runs take two more sources, `openclaw` and `capy`, beside `claude-agent-sdk` and `codex-sdk`: an agent registered with `sdk: {runtime: "openclaw"}` or `sdk: {runtime: "capy"}` reports its runs from that platform through the same start, events and complete calls, and shows in the console as OpenClaw or Capy. Execution stays on the platform, as with the SDK libraries. See [Report runs from OpenClaw or Capy](docs/tutorials/platform-sdk-runs.md).
The accepted runtimes now come from one list in the server (`SDK_RUNTIMES`), used by the OpenAPI schema, agent validation and the run launch, and the refusal for an unknown runtime names all four. The client's `AgentRunBackendLearning.begin` accepts the two new runtimes.
