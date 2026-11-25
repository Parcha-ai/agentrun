---
packages: @parcha/agentrun-serve
kind: fix
---
A seal key of the wrong shape is now refused with the length it wants and the length it got, never the key itself. Before, `AGENTRUN_SEAL_KEY` set to anything other than 32 bytes in base64 gave "is not 32 bytes in base64" at a start, and "none was handed" or "none was handed over" elsewhere, even though one was handed. Every refusal that reads the key now says "is not 32 bytes in base64 (43 characters, or 44 ending in =; it has 60)", for example: at a start, in a kept key file, in an import of the server's own secrets, in the stores of MCP server credentials, tool keys and the server's own secrets, and in a runner. "None was handed" now appears only when none was. A host whose secret generator counts bytes where characters were meant now shows the cause in its first start's log.
