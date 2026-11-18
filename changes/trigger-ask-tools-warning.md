---
packages: @parcha/agentrun-serve
kind: feature
---
The console's trigger forms (schedule, webhook, GitHub, app and feed) and a trigger's page warn when the trigger's agent has a tool whose permission is ask and the agent's approvals are not "never": "A run from this trigger stops and waits for you when it calls <tools>; later firings are skipped while it waits." The warning offers one fix, Run unattended, which saves a new revision of that agent with `approvals: "never"` on the revision the page read (its ETag), as the agent editor saves one. The tools named are those `GET /v2/agents/{id}` lists with `permission: "ask"`; the server's defaults and the gate are unchanged. A workflow agent, which has no approvals to set, is never warned about, and a failed read of the agent shows no warning.
