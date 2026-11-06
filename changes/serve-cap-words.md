---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A run paused at its spend cap says so in words a first-time user reads: "Not sent: the next step needs at least $0.11, and
this run's cap is $0.05. Raise the cap to at least $0.11 to continue.", and once it has spent, "this run has spent $S of
its $C cap, and the next step needs at least $N". A paid tool's refusal names the tool as the next step. The words name no
model and no request. The refusal's timeline row is an `error` row with `paused: true` (a new optional field on
`TimelineEvent`), so a client shows it as a pause, never as a failure. Its waiting row reads only "Waiting for you to
raise the cap": the words are `pending.said`'s. What the run spent and holds reads to the nearest cent ($0.0237416 reads
$0.02); `pending.spent_usd` keeps the exact amount.
