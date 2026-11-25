---
packages: @parcha/agentrun-serve
kind: fix
---
A fal job priced by its settings (Kling v3, Veo 3 and 3.1, Ideogram, Nano Banana, sync-lipsync v2, Fabric) can't be priced when get_pricing states its endpoint in another unit than the one its tiers were decided in (per second, minute or image): under a spend cap it is refused unsent, and without one it is booked as an unknown charge. Before, the tier's ratio and its model-page rate were applied in the new unit, so sync-lipsync v2 stated per second would have been held and booked at its per-minute rate for every second (60 times its bill), and one 4K Nano Banana 2 image stated per megapixel at $2.72 against the $0.16 fal bills.
