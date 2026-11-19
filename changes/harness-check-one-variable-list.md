---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun harness-check`'s `tools_off` stage passes when the agent's first model request reached the provider. The model proxy refuses a request that offers a tool its policy does not allow, so the check no longer applies Goose's tool rule a second time, and the report drops `proxyAllows`; the agent's tools that are not AgentRun's are still listed (`notOurs`), and the proxy's refusals beside them (`proxyRefusals`). The variables the adapter and the model proxy set in the agent's environment are one list, by part (inherited from the host, reserved for the private HOME, the proxy's), which the recipe loader refuses and the check's `env_allowlist` expects.
