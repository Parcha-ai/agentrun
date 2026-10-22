---
packages: @parcha/agentrun-dsl
kind: fix
---
A recovery driver waits out an effect's `deadline_s` and a poll's `interval_s` whatever their size. Before, a deadline with a fraction of a millisecond (`deadline_s: 1.0005`) threw `ERR_OUT_OF_RANGE` once the effect was admitted, so the effect was never dispatched and was left unknown. A deadline past Node's timer limit of 2^31-1 ms, about 24.8 days (`deadline_s: 3000000`), fired at once with a `TimeoutOverflowWarning`, aborting the effect as it started and leaving it unknown. A poll wait past that limit checked again with no wait at all. The effect's deadline still aborts with the `TimeoutError` a host reads as a deadline.
