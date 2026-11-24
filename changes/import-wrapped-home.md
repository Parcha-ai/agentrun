---
packages: @parcha/agentrun-import
kind: feature
---
`wrappedHome(home, year)` reports a year of work under a home: tokens, requests, days, hours of the day, weekdays and time at work, by model, harness and source, each bucketed by its request's time in the machine's local zone (a session that spans New Year splits; it counts in `sessions` for the year of its first request). Cost is the catalog's list price of the requests it could price, with `unpricedRequests` counting the rest. It holds counts, names and times only. `parseHome` takes a `requests` option, called with each session's totals and its requests, which it is built on.
