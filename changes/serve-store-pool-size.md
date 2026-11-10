---
packages: @parcha/agentrun-serve
kind: feature
---
`AGENTRUN_STORE_POOL_SIZE` sets how many connections the server's and each runner's Postgres store holds at once (default 10, as before). It takes a whole number from 1 to 1000; any other value stops the server or runner at start with a message naming the setting, its range and the value given. `deploy/README.md` lists it with the other store settings.
