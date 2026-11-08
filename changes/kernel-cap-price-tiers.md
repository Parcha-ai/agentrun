---
packages: @parcha/agentrun-kernel
kind: ci
---
The kernel's spend cap, still unused until the cutover, prices a model with tiers as its provider bills it: a request whose whole input (fresh and cached) passes a tier's threshold is held, and booked where the cap prices it, at that tier's rates, as pi-ai's calculateCost prices it on the catalog's own table. Before, it held such a request at the base rates, half the bill for gpt-6-sol past 272,000 input tokens, so a run could pass its cap by up to 2x. `ModelPrice` takes the catalog's `tiers` as given.
