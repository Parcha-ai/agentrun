---
packages: @parcha/agentrun-serve
kind: fix
---
A pi run whose request was stopped or cancelled mid-answer now reads its cost as unknown with what is known so far, never $0: the request is marked when it is sent and its end is marked when it did not answer at a price. A workflow that parks at its spend cap names the node it parks at, also for a map's items. A map whose items are held at the cap at once parks only after every item's held end is committed, so the raise resumes them instead of failing on an effect left unknown, and a polled call held for a raise has its poll window moved back by the time it was held.
