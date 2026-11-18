---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
A learned workflow's check and its shadow audit compare two answers on the fields that carry the decision, not word for word. A definition's `learning` takes `agree_on`, the answer's top-level JSON keys (e.g. `["mcc", "riskTier"]`, 1 to 16 distinct keys of 1 to 64 characters, kept in the order given; a bad list is a 422 under `definition.learning`): both answers must be JSON objects holding each key with equal values. Left out, the agent's `output_schema`'s top-level `enum`, `const` and boolean fields stand in, so an agent with an answer schema promotes out of the box; with neither, the whole answer is compared as before, and a check that agreed on none says to name the fields. The check record keeps `agree_on` and `agree_from` (`definition` or `schema`), and its reason says "said what the agent said on mcc and riskTier".
