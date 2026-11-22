---
packages: @parcha/agentrun-serve
kind: fix
---
The console's trigger forms make a trigger for a connected agent: a new schedule, webhook, GitHub trigger, app trigger, feed trigger or email trigger asks such an agent for no cost cap and sends none, and says why in place of the field ("None. A connected agent runs in its own CLI, which keeps its own limits: AgentRun cannot cap its runs."). Before, each form required a cap the server refuses on a connected agent's target (422 `target.max_cost_usd`), so no such trigger could be made from the console.
- A schedule edited onto a connected agent drops its cap, and the effort it carried, which the server refuses there too.
- A trigger's page reads the same words under Cost cap for a connected agent, in place of "Agent's default".
- For every other agent the forms are as they were: a cap is required unless the agent has a default one.
