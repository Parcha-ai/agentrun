---
packages: @parcha/agentrun-kernel
kind: fix
---
A node's review that rejects a candidate without a message now rejects it on a harness other than pi. `createHarnessRunner`'s `submit` read the review's `message` as the rejection, so a review answering `{ accepted: false }` with none let the candidate through as the node's result and told the model it was accepted; a null, empty or blank message rejected with no words. Each now rejects, and the model reads that the review rejected it without saying why, as on Pi's runner.
