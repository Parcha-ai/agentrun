---
packages: @parcha/agentrun-web
kind: fix
---
A keyed Firecrawl search or `web_fetch` answered 408 or 5xx is charged the `creditsUsed` the answer reports, never above the hold, and 0 credits when it reports none, since Firecrawl does not charge a request that fails outright. Before this, such an answer was charged the hold, which for an uncapped fetch is 10,000 credits ($9.90). A request that fails after it may have left, with no answer, is still charged the hold.
