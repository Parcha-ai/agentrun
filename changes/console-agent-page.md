---
packages: repo
kind: feature
---
The console gives each agent its own page at `#/agents/{id}`. The header shows the current revision's harness, model (the server's default, named as such, when the revision sets none), thinking and revision number, and says when the agent is archived. The Runs tab, the default, lists the agent's runs newest first. Each row links to its run and shows its status, when it started, how long it ran once ended, and its cost once known. A workflow agent also has a Workflow tab that draws the current revision's graph read-only. The editor moves to `#/agents/{id}/edit`, reached from the page's Edit button and the card's Edit icon. A card, its History icon, Mission Control's runs per agent and a newly created agent all open the page now. `#/runs?agent={id}` still lists one agent's runs.
