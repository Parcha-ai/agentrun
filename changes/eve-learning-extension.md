---
packages: @parcha/agentrun-eve, @parcha/agentrun-client, @parcha/agentrun-serve
kind: feature
---
Connect an existing eve 1.0.0 agent through an additive extension, preserving its model, tools,
permissions and durable execution. AgentRun records the actual eve runtime, checks learning from
complete task evidence, and supplies accepted notes and skills to subsequent turns. Stable turn
keys and committed-stream replay prevent duplicate records on retry. Learning Off supplies no
learning to a new turn. The extension is held from publication while its integration is reviewed.
