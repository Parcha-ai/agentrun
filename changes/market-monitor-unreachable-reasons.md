---
packages: @parcha/agentrun-serve
kind: fix
---
`market-monitor`'s `unreachable` lists each page it could not read with why (`{url, reason, detail}`; reason `blocked`, `not_found`, `error` or `skipped`), and the digest's footer names each reason, so a page behind a bot-protection challenge reads as blocked. A 404 it recovered from (the pricing page found elsewhere) and a company with no public pricing are no longer listed. From human QA on agentrun-qa.
