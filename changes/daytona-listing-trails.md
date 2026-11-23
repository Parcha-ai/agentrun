---
packages: @parcha/agentrun-computer
kind: fix
---
A hosted computer that the vendor's listing still leaves out after `timeouts.listedMs` (15 s) is no longer deleted when a read by its id finds it running with its labels: create keeps it and answers it, with a note naming the labels asked for, the machine, the polls and the time waited, and `list()` leaves it out until the listing shows it. Daytona's `GET /sandbox` is eventually consistent (an index the API never writes itself), and on 11-23 it left two new production sandboxes unlisted past 15 s; each had started, dialed and passed its checks from inside, and create deleted it with `the computer was not listed within 15 s of its creation`. A computer still unlisted that reads anything but running fails create `timeout` as before, its words now naming the labels, the machine, the polls, the time waited and what the read found.
- A retry of that request, on the same provider instance, finds the kept computer by its id while the listing still leaves it out, instead of asking the vendor for a second (Daytona refuses the name as `exists`; E2B would make another).
- Daytona's wait is configurable: the provider's `listedMs` option, which serve fills from the new optional key `DAYTONA_LISTED_MS` (a whole number of ms above 0; Settings → Computers or the server's environment). `timeouts.listedMs`, when given, wins.
