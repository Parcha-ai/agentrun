---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP tool's answer is cut by the run's redactor before the model reads it or it is filed in the run's files. Until now an answer was cut only of the credentials of the server that gave it, so a value only the run held (its own model or tool keys, another server's credential) came through as the server echoed it. The cut covers the model's answer and an error answer, the answer a tool's file setting files whole, the rest of an answer too long for the model, filed at `evidence/mcp/<server>/`, and a server's results its meter files. A whitespace-free run over 8,192 characters in a CLI harness's MCP answer, or in its filed copy, now arrives as `[redacted]`, as pi's already did.
