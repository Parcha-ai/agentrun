---
packages: @parcha/agentrun-serve, repo
kind: fix
---
Paste and Replace in model/tool keys, computer providers, workspace settings and MCP credentials read the clipboard on click and fill the selected masked field. Saving remains explicit. Empty or blocked clipboard reads leave a focused input for manual paste; delayed reads cannot overwrite typing or fill a cancelled form.
