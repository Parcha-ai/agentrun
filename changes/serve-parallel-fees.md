---
packages: @parcha/agentrun-serve
kind: fix
---
Parallel's fees for `web_search` and `web_fetch` are now the run's spend. Each search ($0.001 for up to 10 results,
$0.001 for each one past them) and each page Parallel extracts ($0.001 a URL), at Parallel's published price, is booked
as a tool cost (`agentrun.tool_cost`, `charged_by: "parallel"`): a line of its own on the run's timeline, part of its
cost and of `/usage`'s `tools` meter. Under a spend cap each is a paid call, sent only when it fits what the cap has
left; past it a search answers the cap's refusal and a page is the guarded direct fetch, and nothing reaches Parallel.
One sent holds its price until Parallel answers, and a model request checked meanwhile counts it beside the spend, so
the two never pass the cap together. Before, these calls were billed by Parallel but counted nowhere, and a cap did not
hold them.
