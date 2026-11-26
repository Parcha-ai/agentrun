---
packages: @parcha/agentrun-serve
kind: fix
---
In the console, an agent card's Run and Edit now go where that agent runs. For an agent this server runs, Run opens the agent's page, where its Run box is, and Edit opens its settings; before, both opened the coding-agent menu. Native, SDK and CLI agents keep the coding-agent menu. The runs list of an agent with no runs now points to the page's Run box when that agent runs here, instead of a Run agent button the page does not show.
