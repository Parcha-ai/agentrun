---
packages: @parcha/agentrun-serve
kind: fix
---
Approvals on the runner:

- **An answer after a stop or cancel is 409.** An answer to a waiting call sent after the run was stopped or cancelled is now refused at once with 409 (`already_answered`, with decision `withdrawn` or `canceled`), even before the runner has applied the stop. It used to be accepted with 204 and then dropped, though the call never ran.
- **A cancel's waiting calls read cancelled.** A cancelled run's waiting calls read cancelled with their run ("Withdrawn when the run was cancelled", "Not run: the run was cancelled while it waited"), not stopped. Their answer entry's decision is `canceled`.
- **A call that waited reads in order.** Its rows read: the call, then its approval row, then what came of it. That holds when the call's result arrives after the answer, and when a second call is waiting too.
- **A write that waited shows no "Saved" row of its own.** What an allowed write saved is its outcome row's to say, and a denied one saved nothing.
- **A declining message is the person's own row.** A person's message that declines a waiting call shows as their own message row, between the approval row and what came of it. An allow written before such a message stands: the call runs once, and the message reaches the run as its next message.
