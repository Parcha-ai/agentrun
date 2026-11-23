---
packages: @parcha/agentrun-serve
kind: fix
---
A seal key of the wrong shape now says what was wrong in the refusal that stops the start. Before, `AGENTRUN_SEAL_KEY` set to anything other than 32 bytes in base64 gave only "is not 32 bytes in base64". The refusal now also gives the length it wants and the length it got: "is not 32 bytes in base64 (43 characters, or 44 ending in =; it has 60)". A key file in the data directory that holds no key is refused the same way. Only the length is shown, never the key itself. A host whose secret generator counts bytes where characters were meant now shows the cause in its first start's log.
