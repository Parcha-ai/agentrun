---
packages: @parcha/agentrun-serve
kind: fix
---
What the learning reads serve is cut of more of what the server never shows:
- An agent's learning routes (its view, its notes and log, a note read, a run's learning and its learning diff) cut the agent's own browser sign-in pointers, live and forgotten, beside the server's secrets. A person's note write refuses them as it refuses a secret. When one of them doesn't open on this server (its seal key changed or is missing, or the sign-in is damaged), each of these routes answers 403 `forbidden` rather than serve what the agent learned over a shorter cut.
- A merged run's learning words are cut again whole, as a dropped run's are, so a problem's path the checks left out names no secret.
- A run's learning `reason`, each problem's `rule` and each verdict item's `origin` are cut as every other text is.
- A served learning text holds no loopback address (the address alone reads "a local address", as in a run's words; a note's `url:` label, its line ends and a workflow.json's JSON stay): a run's learning problems and its diff's patches too. What a run is given keeps it: its `.learning/` files and its `# Learned` section. A note shown without one, like a note shown with a secret hidden, is refused an edit: retire it and write a new one.
Upgrading: a client of the agent learning routes and of a run's learning and its diff handles a 403 `forbidden` there.
