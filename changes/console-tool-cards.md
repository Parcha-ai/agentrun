---
packages: repo
kind: fix
---
The agent editor's Tools & skills cards are one height. Each shows the tool's name (cut to one line, whole on hover and in Details) and one line for people: the server's `blurb` where it sends one, else the description clamped to two lines. Its state shows as a short tag ("Sandbox-only" or "Workflow only" for those two states, else the reason itself on one line, such as "Needs BROWSERBASE_API_KEY, …"), with the full reason on hover. Details shows the model-facing description and the reason in place; that card grows, and its row-mates stay as they were.
