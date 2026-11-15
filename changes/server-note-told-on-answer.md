---
packages: @parcha/agentrun-serve
kind: fix
---
A server note (the replaced computer's, the spend cap's wrap-up, the free-model limit's wrap-up) now counts as told only once a request carrying it is answered. Before, it counted as told when the request was admitted, so a request that then failed (an upstream 429, an error status, a lost or cut stream, a runner stopped before the answer) took the note with it, and the harness's retry or the resumed run went out without it: the model never saw it. On a route serve translates (OpenRouter's), a provider's error status counts as a failure too, not as an answer. The failed request gives the note back, the retry carries it, and the timeline row is written once, when the note is answered. One request at a time still carries it.
