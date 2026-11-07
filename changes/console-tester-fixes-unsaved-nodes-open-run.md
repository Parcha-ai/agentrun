---
packages: repo
kind: fix
---
The console's agent editor no longer drops unsaved changes silently. While a field differs from what was loaded or last saved, leaving the editor (the sidebar, its back arrow, any link or address, sign-out) asks "You have unsaved changes. Leave and discard them?": Cancel stays, with the address and the edit kept; Leave goes and drops them. A tab close or reload gets the browser's own question. Nothing changed, right after a save, a new agent's Create, or the editor's own steps: nothing asks. While a new agent's Create is under way its form is read-only (the button reads "Creating…"), so the page it opens never asks and no second Create is sent; a refused Create gives the form back as it was.
A workflow graph's node count (the agent page's Workflow tab, the editor's Workflow step) is the nodes it draws: a new Workflow agent says "1 node", not "2 nodes", and a new Decision agent "4 nodes", not "5"; the root chain its steps sit on is no box of its own. A container's "… N nodes" says "1 node" for one.
The agent page's Latest run offers "Open the run" as a button like the page's Edit (bordered, square), not small grey text on the date's row.
