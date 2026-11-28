---
packages: @parcha/agentrun-serve
kind: fix
---
A ChatGPT plan renewal whose write back faults no longer gives up when one read back finds the store busy. A read back that faults for a while (the store busy, past its deadline, or a Postgres query unanswered) is read again, and the write is never sent again for it, so OpenAI's refresh token is still spent once. A read back is tried again only while it, the store calls that may follow it and a 5 s margin fit inside the refresh lease, and never once the server's stop has begun. A read back still faulting at that bound leaves the outcome unknown as before: the new pair is kept, never revoked, and the lease is held to its end, never given back with the old pair. Each retry logs `read_back_retry` with the fault's class.
