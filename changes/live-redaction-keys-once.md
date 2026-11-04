---
packages: @parcha/agentrun-serve
kind: fix
---
A streaming thinking or text block no longer reads the saved keys' file at every delta. The live Timeline redaction opened and unsealed each saved key once per delta, which comes to hundreds of reads for a long answer. It now keeps the saved keys it opened until one is saved or deleted. A key saved while a run streams is redacted from the next delta on.
