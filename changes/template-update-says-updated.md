---
packages: @parcha/agentrun-serve
kind: fix
---
In the console, updating an agent from a template (Update <agent>) now says it was updated and names the new revision ("Updated: rev 2"). It used to say the template was applied and "The agent is made", as if the apply had made a new agent. Only an Apply that makes a new agent says "made".
