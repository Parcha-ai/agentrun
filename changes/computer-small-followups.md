---
packages: @parcha/agentrun-serve
kind: fix
---
Three small computer fixes. A provider's connection test (`POST /v2/computers/{provider}/test`) passes its answer through the server's one redactor over the keys it used, so a vendor error that quotes a saved key in another form (base64 in an `Authorization` header, hex, JSON-escaped, percent-encoded) shows none of it. A run whose computer waits on its image (Docker building its recipe, or pulling an image) shows the "Preparing the computer's image" row on its timeline while it waits, not once the image is ready; a run whose image fails keeps that row, and its end says why after it. The README says that a computer's minutes are billed by its provider and that AgentRun does not count them yet.
