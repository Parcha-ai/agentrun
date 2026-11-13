---
packages: @parcha/agentrun-serve
kind: fix
---
A Timeline row for the agent's words that open with a fenced code block (a JSON answer written as ```json … ```) previews the code itself, on one line, up to the summary's 500 characters. Before, its summary was the fence's first line, so the console's Answer row read only "json…". The row's text, and the run's answer, keep the words whole, fence included.
