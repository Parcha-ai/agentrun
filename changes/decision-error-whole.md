---
packages: @parcha/agentrun-dsl, @parcha/agentrun-serve
kind: fix
---
A decision receipt keeps its request's error whole up to 64 KB (it was cut at 2000 characters), marking a longer one `error_truncated`. A workflow run's graph redacts a decision's error before it cuts it, and holds back the tail of one stored cut (marked, or exactly 2000 characters from before), as it does a call's, so a held key across the cut shows no part.
