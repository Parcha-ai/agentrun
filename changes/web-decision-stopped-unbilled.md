---
packages: @parcha/agentrun-web
kind: fix
---
A classifier request (Jev's, or any decider's: a search sift, a fetch's passage judge, a page guard) that a stop kept from leaving the process is no longer billed at its hold. One on a call already stopped asks for no payment. One stopped while its payment was being admitted is never sent, settles at $0, and its receipt line reads `not billed (aborted)`. Before, the provider's own stop before sending read as a failure that may have been billed, so the run paid the request's full hold. A request stopped after it was sent is still billed as before.
