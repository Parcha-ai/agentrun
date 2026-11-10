---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server signed in with OAuth stays signed in when its owner refreshes its tools or saves it without a new credential. Those writes now leave the stored credential, its token's end and any refresh lease as they are, by a compare-and-set on the credential the owner read; a runner's refreshed token set kept meanwhile stands, and a refresh in flight still keeps its set. When a run keeps changing the credential during the write, the change is applied again onto the fresh row, and after three tries it is refused in words ("... credential kept changing while this save was made ...; nothing was saved. Try again.").
