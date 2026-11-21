---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: fix
---
Template packages such as Inbound Lead and KYB accept and retain their `learning.agree_on` settings through import, apply and later edits. A learned workflow's promotion check and shadow audit compare the declared answer fields, with each dotted path required in the template's output schema; a missing path disagrees. Without `agree_on`, the existing whole-answer comparison remains. The console and API describe which fields the check compared.
