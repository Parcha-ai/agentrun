---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: breaking
---
The kernel and the Claude Agent test kit drop exports nothing in AgentRun used. From `@parcha/agentrun-kernel`: the `delegate` tool (`delegateTool`, `DELEGATE_TOOL`, `DELEGATE_RESULT_SCHEMA`, `delegateProblems` and the `DelegateAgent`, `DelegateEvent` and `DelegateOptions` types). From `./kernel`: the follow-up turn (`followUpOnce`, `followUpState`, `followUpKey`, `FOLLOW_UP_EFFECT`, `FOLLOW_UP_BUDGET_REACHED`, `FOLLOW_UP_CANCELLED` and their types) and `BASH_MAX_TIMEOUT_S`. From `./process`: `lastTurnEnd`, `summarizeBatch`, `batchTranscript` and `zodFromJsonSchema`. From `@parcha/agentrun-harness-claude/testing`: `lastUserText`. An embedder that imported one of them keeps its own copy: each was a small helper, or a feature the server never wired (a follow-up turn, a delegate tool). `zodShapeFromJsonSchema` stays.
