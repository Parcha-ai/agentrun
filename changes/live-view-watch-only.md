---
packages: @parcha/pi-browser
kind: fix
---
The live view's watch-only mode reads as watching. A view-only viewer shows "View only: you're watching the agent's browser; your clicks and keys are not sent." in a banner of its own, never the take-over wording that input is held, with the page's address beside it as plain text (cut with an ellipsis, the whole address in its tooltip), and no toolbar (its back, reload and address field acted on nothing there). In every mode the page fills the window at its own shape and follows it as the window resizes, with clicks still landing where they are made, and the end of a session (released, refused or disconnected) reads in large type over a dimmed page.
