---
packages: @parcha/agentrun-serve
kind: fix
---
A burst of saves granting monid endpoints no longer loses grants to monid's rate limit. A save's read of monid's listing or an inspect that monid refuses for its rate (429), fails (5xx) or leaves unanswered past the request's limit is sent again after monid's Retry-After (250 ms at least), at most 20 times and for up to 20 s of waits, inside 45 s of the save's start, and only then refused, in the same words as before. One server's saves share those reads: saves that arrive together read the listing once and each endpoint once, each waiting on the other's read no longer than its own 45 s, and a read that answered is reused for 60 s. A refusal monid gives as sent (401, 403, 404), or monid out of reach, still refuses the grant at once.
