---
packages: repo
kind: fix
---
The console's agent editor no longer drops unsaved changes silently. While a field differs from what was loaded or last saved, leaving the editor (the sidebar, its back arrow, any link or address, sign-out) asks "You have unsaved changes. Leave and discard them?": Cancel stays, with the address and the edit kept; Leave goes and drops them. A tab close or reload gets the browser's own question. Nothing changed, right after a save, a new agent's Create, or the editor's own steps: nothing asks.
