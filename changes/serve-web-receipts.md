---
packages: @parcha/agentrun-serve
kind: fix
---
A template eval's link check now counts the links a web call's text holds: those in a fetched part's text (a part past the first lists no links of its own), in each chunk an objective found, and in a native search's text. Before, a link the model read there and cited was reported as `no matching call`. Each `web_search` and `web_fetch` call a run's Web answers also writes one `web_receipt` line to the server's log: `op`, the `provider` that answered, `tries` (each provider asked as `provider:outcome`, a failure's code after a `/`), the `classifier` (`off`, or `ran` or `not_run` with `classifier_in`, `classifier_kept`, `classifier_model` and any error code or skip reason) and `cost_usd`, so the provider chain and Jev's ranking can be audited from the log. The line never holds the URL, the objective or queries, a page's text, an error's message or a key.
