---
packages: @parcha/agentrun-serve
kind: feature
---
The server ships five template packages, none needing a sandbox: `code-review`, `kyb`, `market-monitor`, `inbound-lead` and `release-notes`. No package puts a write or a send in its `allow`: each one reads content someone else wrote, and a write asks until the owner grants it at apply.
- **`kyb`**, business due diligence on one company:
  - identity from primary registries, owners and officers;
  - sanctions screened against the OFAC, UN, EU and UK lists through the list owners' own records, never a news article about them;
  - dated adverse media, red flags graded by the owner's risk appetite, and a verdict.
  Every claim is cited, and nothing is invented.
- **`market-monitor`**, a weekly digest of what changed at the companies you watch: launches, pricing, hiring, funding and news. Each item is dated and linked, and an event counts only when it happened in the window. It sends to one Slack channel ID or one email address set at apply. Its schedule comes from its `cron` and `timezone` parameters, Monday 08:00 UTC by default.
- **`inbound-lead`**, a webhook trigger for form or CRM submissions:
  - it researches the person and the company, and scores the lead against the owner's ICP with evidence for each criterion;
  - it writes back to HubSpot only onto the contact whose email matches the lead, or posts to one Slack channel ID.
- **`release-notes`** turns the PRs merged since the last release into user-facing notes and leaves them as a draft issue to edit. No MCP tool makes a draft release. It never publishes. With no GitHub server saved, it works from a list of PRs in the message.
- **`code-review`** reads through the GitHub tools when it has no shell (never cloning), and reads its rules with `read`. It gains a `focus` parameter and six eval cases.

A package parameter may have a `default`. A schedule's `cron` and `timezone` may come from parameters; such a parameter needs a default, and the package's own schedule is checked with it. Apply now checks every trigger, its parameters filled, before it makes anything: a bad cron or zone, a date that has passed, or a webhook trigger on a server with no seal key (`409`, `triggers.<i>`) refuses the apply with nothing made. Before, the trigger's create failed after the agent was made and archived it. The templates README documents the eval cases, one fake MCP server fixture format, and how to scope a saved server's credential.
