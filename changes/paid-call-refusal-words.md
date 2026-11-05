---
packages: @parcha/agentrun-serve
kind: fix
---
A paid tool's spend-cap refusal (a browser, monid or Parallel call) no longer counts money held for requests still
answering as spent. It is now one sentence, like a model request's refusal: what the run spent, and what it holds for
calls still answering, of its cap; what the call could cost; and the cap that would run it, at least a cent above the
current one. Every amount uses one format. A model request refused for no price, no output ceiling, an unmeasured input
or an unknown spend now says "not sent" once, and writes its cap in that format too.
