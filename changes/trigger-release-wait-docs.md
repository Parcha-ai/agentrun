---
packages: @parcha/agentrun-serve
kind: docs
---
The OpenAPI description of `POST /v2/triggers/{trigger_id}/firings/{firing_id}/release` now says what the server already does. A release waits out the engine's whole turn on the firing, a hook call still open included, not only while the hook's answer is being written. After a transport error, the host sends the same call again: a firing already released answers 200 with it, unchanged, whatever its words. Or it reads the firing in the trigger's firings. Releases alone turn a trigger off only after the failures in a row that pause it land with no 2xx between them, and any other failed firing counts in the same streak. No behaviour changes.
