---
packages: @parcha/agentrun-serve
kind: fix
---
In Mode 2 (workspaces on Archil) a new agent that names no place now runs on the runner, with bash on Archil's serverless exec, even where Docker answers. Before, it got Docker's box, which can't mount Archil's workspaces, so every run was refused: a race could not start, and neither could an agent made with the form's default tools. `capabilities.places.default_place` is `{"mode": "runner"}` in Mode 2, and the start's Boxes line says so. A race lane whose run the server refuses now has its agent archived at once, so a refused race leaves no agents behind.
