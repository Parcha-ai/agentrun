---
packages: @parcha/agentrun-serve
kind: fix
---
A share host answers a deleted or unknown share's link with the share page, not the API's JSON error. The page keeps the status (`410` for a deleted share, `404` for none) and says why from its own read of the bundle: "This share was deleted." or "There is no share at this address." The bundle at `/r/<id>/bundle.json` and the API keep their JSON answers.
