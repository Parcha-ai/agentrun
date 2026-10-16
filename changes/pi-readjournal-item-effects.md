---
packages: @parcha/agentrun-pi
kind: fix
---
`readJournal(file, key).effects` lists every effect of a journal in the keyed layout (`agentrun.frozen_run.v4`). It listed only the ones the driver's record keeps, so a reader of a v4 run missed every outside call made inside a map, unknown ones included, and nested maps' too. Each map item's record lists the effects it owns, and they are now read from there: every effect once, in the order they were admitted, as the whole layout lists them. A resume was never affected: the recovery driver reads the items itself. `state` stays the driver's own record; in the keyed layout what lies in each map item is in that item's record.
