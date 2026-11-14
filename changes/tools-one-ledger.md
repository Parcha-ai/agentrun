---
packages: @parcha/agentrun-serve
kind: fix
---
A paid tool call books on the run's one ledger or is not sent. A `monid.run`, a search or extract through Parallel (`web_search`, `web_fetch`) and a browser call or a person's browser time that find no run's ledger to book their price under are refused unsent, in words that say so (`monid.run was not sent: this call has no run to book its price under.`), as a priced MCP call already was. Before, each of them was sent and booked off the ledger, against a per-process spend count the run's cap never read. Every run the runner drives has a ledger, so its paid calls book and refuse exactly as before.
A learned workflow's web nodes (`web_search`, `web_fetch`) now book on the run's ledger like the run's own calls: the run's cap holds their price before they are sent and refuses one that would pass it, in the cap's words.
