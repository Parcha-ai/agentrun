---
packages: @parcha/agentrun-serve
kind: feature
---
The console compares runs at `#/compare?runs=<id>,<id>`: two to four runs' Dev tools figures side by side, a column a run in the order the address names them. It shows each run's model requests, tool calls, failures, tokens, share of input read from cache, cost and time, then each tool's calls and time and each model's requests, tokens and cost. With two runs it also says the second against the first. A figure a run's trace does not carry is said as not known, with no difference: a CLI harness's requests, tokens and model time, and a model it recorded no request to. Nor is a difference said of a figure that is not exact: "at least" for a run whose trace is its first 2,000 requests and calls, whose requests did not all report tokens, or a time where a request's or a call's length was not recorded, "at most" for a cost that counts a cut request at what was held for it. Each run and its trace are read once, when the page opens.
- A race's page links to it ("Compare in figures") once it has two lanes, in the lanes' order.
- A run's Dev tools tab has Compare, which asks for the other run by its id or its page's address.
