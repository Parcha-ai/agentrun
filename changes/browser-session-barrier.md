---
packages: @parcha/agentrun-serve, @parcha/pi-browser, @parcha/pi-durable-disk
kind: fix
---
A browser session's open is durable before its vendor creates it. pi-browser takes `beforeCreate`, a host's step between the session's `creating` record (its tag, in the inventory) reaching the store and the provider's create; one that throws creates nothing and ends the record released. serve's browser spend uses it: the open is recorded in the run's journal (`agentrun.browser_session_open`: the tag, the conversation, the call's hold) and the journal is synced (barriers.ts `browserSessionOpen`, active) before the vendor is asked, so a box loss on a run at `synchronous = NORMAL` never leaves a billed session that no record names: the next process finds it by its tag and releases it. NORMAL's precondition `browserSessionBarrier` is done.
