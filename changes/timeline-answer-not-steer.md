---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
The person's answer to an agent's question is no longer shown as a steer. `ask_person` ends its turn, so the answer is the person's next message, but the timeline labeled every message that came straight after a tool result `You (steer): ...`. The timeline gains `registerTurnEnding(tool)`, for a host's tool that ends its turn, and serve registers `ask_person` with it. A message after a round whose tools all end the turn reads `You: ...`; a steer into a running turn reads as before.
