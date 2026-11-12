---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run started inline (`POST /v2/runs`) under a new version of its agent is titled with that version's name. It used to show the previous version's name on its page and in the run lists. A run of a version already stored keeps the agent's current name.
