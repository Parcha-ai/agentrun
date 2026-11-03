---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run with a spend cap no longer reads back more than it can have spent after its process restarts, which could refuse its next request with `spend_cap_reached` though the cap had room. A request a crash cut counts at the worst case its start mark holds. The spend read back took the largest such figures in the whole run, including requests an answer or a stop had already closed: a request answered at $0.20 (held $0.30) followed by one cut (held $0.10) read as $0.50, not $0.30. The marks are now read in order. Each request still open counts at its own start's figure. Where requests overlap and an answer could have closed either, it counts at the larger, so the spend is never read as less than what can have been billed.
- An older start with no figure that an answer closed before the cut request started no longer makes the spend unknown.
- pi's error for a request whose start mark could not be written, which never left, no longer counts as answering another request in the spend read back. Before, it could close a request still in flight, so the spend after a crash could be read as less than what that request can have cost.
