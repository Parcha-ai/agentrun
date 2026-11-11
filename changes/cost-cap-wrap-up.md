---
packages: @parcha/agentrun-serve
kind: feature
---
A capped run now wraps up instead of running into its cap with no answer. Once its spend plus what its requests and paid steps still out are held at reaches 75% of the cap, the run's tool gate refuses every tool call a model makes, in every conversation of the run and on every harness, with one fixed message: "Budget nearly spent: stop calling tools and answer now from what you have." A call that would start a child conversation (a `subagent` spawn) is refused the same way. Children already working are not cut: they get the same refusal and answer. Model requests continue, so the parent's final answer lands, and the cap stays the last line. The figure is read from the run's booking records at each call, so a restart or a moved claim holds the same line, and a raise of the cap moves it.
- Upgrading: this changes how a capped run ends. A run that used to end `spend_cap_reached` (or pause at its cap) after its in-flight reservations filled the cap now stops calling tools at 75% and answers from what it has. A run with no cap is unchanged.
