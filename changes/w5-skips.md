---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
Twenty test cases that were skipped against the cutover run again and pass (cap, cost-so-far, decisions, graph redaction, gateway, capacity, tool plane and others), each checked to reach the behavior its title names. Every skipped case that still fails, or that would pass without reaching its subject, stays skipped.
