---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve eval-template` no longer sits through fixed waits. A run that reads queued has its next claim read when it falls due (just past the queued bound, or as a bound that a read finding no runner started ends), and its timeline page waits no longer than that, so a run nobody holds is cancelled as its bound ends rather than up to 5 s later. The eval's own server serves a run's end within a quarter second rather than a second, and the command refuses a bad flag before it loads the eval.
- A run's timeline page now changes while the run reads queued when a runner takes it or its claim lapses, so a long poll on it wakes then. The page of a run that has shown its first rows is unchanged.
