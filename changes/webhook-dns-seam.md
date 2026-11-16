---
packages: @parcha/agentrun-serve
kind: fix
---
A webhook delivery whose receiver's name lookup was still out when the server stopped no longer leaves that lookup's failure (a name that answers NXDOMAIN) as an unhandled rejection, which could end the process as it stopped. The try gives up in words ("not reached: the server is stopping"). `ServeOptions.webhookLookup` is a test's seam for the receiver's name lookup, so the tests' servers answer their example webhook hosts without the system resolver.
