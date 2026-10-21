---
packages: @parcha/agentrun-pi
kind: fix
---
The `/agentrun` command shows an error's own text only when the extension wrote that text for the operator: its own messages, `WorkflowStoreError` and `ExtensionServiceError`. Any other error shows the generic message. Before, it showed any error whose text began like one of the extension's messages (`Workflow`, `Code`, `SOP`, ...), so a host callback's own error starting that way reached the operator as written.
