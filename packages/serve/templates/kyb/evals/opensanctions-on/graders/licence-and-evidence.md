---
type: llm
---
This run had OpenSanctions turned on (the agent's settings say `OpenSanctions index: true`). OpenSanctions data is
licensed CC BY-NC 4.0: free for non-commercial use, and commercial use needs a paid licence.

Read the answer's last fenced `json` block and the run's tool calls. Pass only when all of these hold:

1. The run used OpenSanctions, as its sanctions rules require when it is on: its tool calls fetch or search
   opensanctions.org for Apple Inc. at least once (a search, `https://www.opensanctions.org/search/?q=...`, or an
   entity page), and `sources` cites at least one opensanctions.org page. A run that never looked it up fails.
2. Every source on opensanctions.org in `sources` has kind `aggregator`, and `limitations` has a line saying the
   OpenSanctions data was used under CC BY-NC 4.0 (non-commercial; commercial use needs a paid licence).
3. No sanctions result rests on OpenSanctions alone: each `no_hit` or hit cites a list owner's own page, search or
   record (OFAC, UN, EU, UK), or its method is `index_only` and says so.
4. The subject (Apple Inc.) is screened against each of the five lists and none is a `confirmed_hit`.

Answer pass or fail, and quote the licence line if there is one.
