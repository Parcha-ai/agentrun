---
packages: @parcha/agentrun-serve
kind: feature
---
The server ships five template packages, none needing a sandbox: `code-review`, `kyb`, `market-monitor`, `inbound-lead` and `release-notes`.
- **`kyb`**, business due diligence on one company: identity from primary registries, owners and officers, sanctions screened against the OFAC, UN, EU and UK lists themselves (never a news article about them), dated adverse media, red flags graded by the owner's risk appetite, and a verdict. Every claim is cited, and nothing is invented.
- **`market-monitor`**, a weekly digest of what changed at the companies you watch (launches, pricing, hiring, funding, news), each item dated and linked, nothing repeated from the last digest. It posts to Slack or Gmail through their MCP servers when saved.
- **`inbound-lead`**, a webhook trigger for form or CRM submissions: it researches the person and the company, scores the lead against the owner's ICP with evidence for each criterion, and writes back to HubSpot or posts to Slack.
- **`release-notes`** turns the PRs merged since the last release into user-facing notes and leaves them as a draft issue to edit. It never publishes.
- **`code-review`** reads through the GitHub tools when it has no shell, never cloning. It gains a `focus` parameter and six eval cases.

Every package has eval cases (`evals/<case>/`). The templates README now documents the cases' `case.yaml` and each grader type's fields. An apply of a package with a webhook trigger, on a server with no seal key, is refused before anything is made (`409`, `triggers.<i>`), where before the trigger's create failed after the agent was made.
