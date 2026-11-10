---
packages: repo
kind: fix
---
The agent editor's tools follow the harness. Switching an agent to a harness that doesn't run one of its tools here (ask_person on Claude, an MCP grant on a harness that runs no MCP tools) unticks that tool at once, and says why under the Harness choice before any save. The Tools step shows it unticked with the same reason, which names the harnesses that do run it ("Runs on Pi here, not on Claude"), Save sends only what the harness runs, and switching back ticks it again. The Tools step's cards are one height, each with one human line (the served blurb), its state as a short tag, and Details for the rest.

Save revision follows the form: it is off with nothing to change and reads "Saved · rev N"; on with an edit (tool settings compared as they take effect: the agent's own, else its definition's). Leaving the editor with unsaved edits asks first (a page move, sign-out, or closing the tab), and a new agent's form is read-only while its Create is under way. A refused save's reason shows under the button, and a new agent says under Create what it still needs (a name, its instructions). The save warnings name the step a line is about (Tools & skills) instead of a raw field like `definition.tools[3]`.

A workflow's node count is the boxes its graph draws, and a run's "Open the run" is a button. Settings → Tools greys out a harness this server can't run, as "not offered here", with the server's reason on hover.
