---
packages: @parcha/agentrun-serve
kind: fix
---
An image's or audio's data or a resource's blob that an MCP answer files whole is now `[redacted]` when the bytes it decodes to carry a secret's shape, such as a JWT or a private key block, even if the run holds no such value. Before, such a payload was cut only for values the run's redactor holds, so an unheld token or key in a file a server returned was filed as it came. The base64 text itself is not read for a shape, since a key's shape turns up there by chance in large images. A claim's MCP now refuses to start without the run's held redactor, before it reads a credential or mints a GitHub token, and the MCP gateway refuses to start without a redactor. Before, the gateway fell back to cutting only the server's own credentials. A caller that builds either one directly must now pass a redactor.
