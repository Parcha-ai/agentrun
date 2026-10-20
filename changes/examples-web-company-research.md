---
packages: repo
kind: feature
---
`examples/web/agents/company-research`: an agent, Desk, whose research prompt depends on the kind of organisation. A base prompt and an overlay for each kind (a public company, a non-profit, a small retailer, an online store) and a generic one are kept as `agent.prompts` in the agent's own home, each overlay with the rule that loads it (`company_kind` is its option at 0.8 or more, from a Jev choice question). `edit-prompts.mjs` checks `prompts.json` and saves it into a home with `setPrompts`, or prints what the home holds. `config-page.mjs` writes one static, script-free page of the base, the overlays with their rules, the generic, and a table of runs with Jev's choice and probabilities (both passes when the host looked the company up), the lookup, the prompt loaded, the outcome and a link to the brief. Eight companies, four clear and four ambiguous, are in `companies.json`. The tests run offline.
