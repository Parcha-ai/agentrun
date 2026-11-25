---
packages: @parcha/agentrun-computer
kind: fix
---
Orgo, Browserbase, Kernel and the local browser make one computer per create request id: a create retried with the same `requestId`, while the first starts or once it is up, answers the computer the first made; the same id with another spec is refused `exists`; and the same id after this provider released its computer is refused `exists` ("was made for this request and has ended: create with a new request id"). A create with no `requestId` is refused `invalid` on each.
- Orgo (Linux desktop): the computer's name begins with `computer-<12 hex of sha256(requestId)>`, then the run's hash, the epoch and the deadline; before it makes a computer, create lists the workspace's computers and answers the request's, compared by its labels, image and sizes.
- Browserbase and Kernel: the `agentrun.create` label holds the request's name; before it makes a browser, create lists the running and starting browsers with that label and answers the request's, compared by its labels.
- Local browser: a browser's id and directory are the request's name, `computer-<12 hex>`, claimed with `mkdir`; a create on the same root that finds the directory answers that browser, compared by its labels and network.
