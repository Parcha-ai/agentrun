---
packages: @parcha/agentrun
kind: feature
---
`agentrun race start --lane HARNESS/MODEL --lane ... --task TEXT|@FILE` runs one task on 2 to 4 harness and model lanes side by side from the terminal, the way the console's New race form does. Each lane is a new agent of its own with a new agent's default tools on that server, plus one run of it carrying the race's task, cap (`--max-cost-usd`, default 1), any `--file` ids, and the labels the race view reads (`race`, `lane`, `harness`, `model`). One refused lane leaves the others started: the refusal is printed and the command exits 1. It prints the label and each lane's agent and run. `agentrun race show LABEL` reads the race back in lane order: each lane's harness, model, run, status, cost, cap and seconds.
