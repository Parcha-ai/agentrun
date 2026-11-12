---
packages: @parcha/agentrun-serve
kind: fix
---
A gateway model written with its version's separators flipped (`gpt-5-4`) is priced when the catalog's entries differ only in a long-context `tiers` table: they are compared on their base price, and the entry that carries `tiers` prices it. Different base prices still leave it unpriced.
