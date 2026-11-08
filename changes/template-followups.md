---
packages: @parcha/agentrun-serve
kind: fix
---
A template package's trigger input is checked against the input its agent takes (`{content: text}`) when the package is read, so a package whose trigger every apply would refuse no longer passes `agentrun template validate` or a server's start. `GET /v2/templates`' `grants` text and the templates README say that a grant is the agent's own tool setting, which outranks a server-wide deny set after the apply. Tests now pin a server-wide `mcp:<server>/*` deny against grants, a saved key satisfying a package's `secrets`, and apply's 413. The code-review skill's event gate reads the event and action from the `<trigger-payload>` tag. It doesn't stop on a field cut from a payload over 16 KiB when the trigger's filter checked that field, and it reads draft, fork and labels with `pull_request_read` after the gate.
