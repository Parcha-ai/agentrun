---
packages: @parcha/agentrun-serve
kind: ci
---
**The agent store's busy tests check that the server answers by order, not by a clock**
- The five tests that hold the agent store from another connection asserted that `GET /capabilities` answered in under 200 ms while a request waited. Under CI load that bound tripped with no stall in the server (277 ms on a Node 24 runner).
- They now send five `GET /capabilities` while the store is still held, and require every answer before the waiting request answers (for a run's end, before its next try of the store). A store wait that blocked the event loop answers none of them until it ends, so the test fails by order whatever the runner's speed.
- The store-timing contracts stay: a create or an edit still waits about as long as the store is held, and a request held past about 2 s still answers `home_busy`.
