---
packages: @parcha/agentrun-serve
kind: fix
---
A run of an agent whose computer is a desktop or a phone is handed that computer's tools on the runner: `desktop_screen`, `desktop_input` and `computer_request_handoff` for a desktop, the phone's tools for a phone, as its groups offer them. Before, the run got only the tools its definition listed, which can't name them, so the model's `desktop_screen` call answered that the tool is not available. They are held to the kind's setting (`desktop`, `phone`), a call made while a person has taken over the computer waits for the hand-back, and the agent's hand-over asks the person through the run's live view.
