---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server's page uses words for people who are not engineers; the API keeps its own. An agent's revisions are **Version 1**, **Version 2**, … with their notes, the hex id a small detail, and the current one is **in use**; **Edit** and **Save** replace "Edit: commit a new revision" and "Commit revision", and **Use this version** replaces "Make current". A run is titled by its input's first line, or by its agent and start time, never by its id. The model is picked from the ones this server runs (its own, each other tier capabilities list, as a definition names it) or typed in as another.
