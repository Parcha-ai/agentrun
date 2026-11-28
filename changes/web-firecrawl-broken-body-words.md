---
packages: @parcha/agentrun-web
kind: fix
---
A keyed Firecrawl answer whose body breaks while it is read now reaches the agent as "Firecrawl's search answer broke off" (or fetch), as other providers' do, in place of "failed to connect". Its charge is unchanged.
