---
packages: repo
kind: feature
---
The console gives each agent its own page at `#/agents/{id}`. The header shows the current revision's harness, model (the server's default, named as such, when the revision sets none), thinking and revision number, and says when the agent is archived. Each tab has its own address (`#/agents/{id}/{tab}`). The Runs tab, the default, lists the agent's runs newest first, an archived agent's included. Each row links to its run and shows its status, when it started, how long it ran once ended, and its cost once known. A workflow agent also has a Workflow tab that draws the current revision's graph read-only. The editor moves to `#/agents/{id}/edit`, reached from the page's Edit button and the card's Edit icon. A card and a newly created agent open the page, and the card's History icon and Mission Control's runs per agent open its Runs tab. `#/runs?agent={id}` still lists one agent's runs.
