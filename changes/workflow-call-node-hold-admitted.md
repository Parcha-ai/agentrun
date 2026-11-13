---
packages: @parcha/agentrun-serve
kind: fix
---
A capped workflow run on the runner takes a paid call node's hold only after the workflow's driver has admitted the call's effect. Held before the admission, a runner that died in between left a hold the next claim counted beside running the call again under a new hold (an `llm` call of $0.001 was counted $0.002). A hold the cap refuses for room now ends the admitted effect held with nothing sent, and the run parks once that end is durable; after a raise the call goes again as a new effect. A hold refused for good, and an answer that cost more than its hold, end the effect failed in the cap's words, as before.
