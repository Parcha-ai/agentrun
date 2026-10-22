---
packages: @parcha/agentrun-harness
kind: feature
---
A demo with a place of its own can pass `providers` when that place shares the run's one labeller: it hands each run process its host box as `HOST_BOX` (`{ provider, key, run }`), which the process claims first, and lets the supervisor read the run's files through two new optional `Place` members in disk's per-path shape, `readRunFile(path)` (`null` for a missing file) and `listRunFiles(dir)` (`[]` for a missing directory); any other failure throws. The supervisor reads the labels from `box-ids.internal/` and parses them itself, so the place's host boxes and the tools' boxes are `box-N` in one numbering across the run. At the final read a host box with no label refuses the recording, naming why (never claimed, unreadable, or not read inside the bound). A place without the reads keeps the supervisor's numbering and is still refused beside `providers`.
