---
packages: @parcha/agentrun-computer
kind: fix
---
A Linux desktop's `input.actions` waits 100 ms after a key action before the batch's next action, so an app has acted on the shortcut first: in LibreOffice Calc, `ctrl+shift+f5` then typed text in one `computer_act` now types into the Name Box instead of the cell.
