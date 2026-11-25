---
packages: @parcha/agentrun-decisions, @parcha/agentrun-web
kind: feature
---
`anthropicProvider()`: a prompted Claude model (Haiku 5.5 by default, through `ANTHROPIC_BASE_URL`) as a `DecisionProvider`, answering noul and choice questions held to a JSON schema, at Anthropic's published price (`ANTHROPIC_PUBLISHED_PRICING`). It is the control arm for the web classifier step in `@parcha/agentrun-web`: `WebConfig.decider` (`deciderFrom(provider, { price })`) sifts each search's results and judges each fetched part in passages before the model reads them, each request held to the run's cap. Without a decider, every answer and receipt is byte-identical to a web with no step.
