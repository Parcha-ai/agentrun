---
packages: @parcha/agentrun-serve
kind: fix
---
A monid call that monid charges more than the run held for it now stops the run at once. The charge is booked at what monid charged, never the hold; the run makes no further model request or tool call and ends failed with the error "monid charged $X, more than the $Y held; the run stopped"; and the runner logs one error line naming the run, the endpoint and both amounts. A charge at or under the hold behaves as before. monid's maxCost checks only its estimate, so this can happen when monid re-prices an endpoint between the price check and the call.
