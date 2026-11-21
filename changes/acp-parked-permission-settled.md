---
packages: @parcha/agentrun-harness-acp
kind: fix
---
A person's answer to an ACP agent's own tool call (Cursor's shell) now reaches the run when the agent, started again, asks for another command instead: the adapter asks about each request the turn left waiting before it starts the agent, so the answer is taken and the run's pending approval moves on, and with no answer yet the run parks again with no prompt sent. Before, the answer was never taken, and the run restarted the agent every few seconds, each time with a new approval, until the plan's turn limit. The recovery note tells the agent what the person answered, and an agent that asks for another command three times (`REASK_LIMIT`) instead of the one the person allowed ends its turn with `ACP_REASK_LIMIT`.
