---
packages: @parcha/agentrun-serve
kind: fix
---
A message sent to a claude-agent, codex or opencode run while it is working, and sent again after its runner restarted, now says so on the run's timeline. Such a message goes to the model as a turn of its own once the turn in flight ends, and is recorded only after it is sent. A runner lost in between used to send it again on the next claim with nothing to show for it: a second paid turn the person never saw. Now the runner marks the message as being sent before it sends it. When the next claim finds that mark on a message it has to send, a row reads "Your message was sent again after the runner restarted: it may have reached the model before, and this turn is paid again." before the message. Each turn is booked as it is sent.
- Upgrading: nothing to change.
