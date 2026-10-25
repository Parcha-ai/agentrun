---
packages: @parcha/agentrun-pi
kind: feature
---
The durable node runner sends a node's user turn as two text parts, the node's input first and its delivery contract (`submitFooter`) second, instead of one string joined by a newline, so a viewer can show the input and fold the contract. `NodeAttempt.user` takes content parts as well as a string. A node attempt that an older build submitted as one string resumes as it was sent: pi answers the attempt's request id with its first submission, and the attempt's digest does not cover the text.
