---
packages: repo
kind: fix
---
Console: agents, pickers and models read the served agent, as one picker.
- Every dropdown is the console's picker (it opens right under its field, on a phone too): the runs' state filter, the run bar's effort, Mission Control's agent, a trigger's agent and its every-unit, Settings → Tools' permissions and providers, and a template's choice parameters. No native select is left.
- Every agent picker lists agents by name, A to Z, ignoring case and accents, a number in a name read as a number.
- A model reads one way everywhere: without the gateway's routing prefix the server names, the full id in its title; an agent that names no model shows its harness's default only as the server names it (`harnesses[].default_model`).
- An agent's page lists its tools with the provider and permission in force; after a save on the page it reads the agent again, and says so with a retry when that read fails.
- The Learning tab's "Learned in" names the run by its short id (its title on hover), and what the next run reads renders as safe Markdown.
- Learned items waiting for the owner's OK are counted from the agent's `learning.pending`: on its page's Learning tab, its card in the Agents list, and Mission Control's Needs you, one row per agent.
