---
packages: @parcha/agentrun-serve
kind: fix
---
A fal job priced by its settings (Kling v3, Veo 3 and 3.1, Ideogram, Nano Banana, sync-lipsync v2, Fabric) is held and booked at no less than its tier's rate on fal's model page when get_pricing states a rate other than the one its tiers were decided at. Before, the tier's ratio was applied to whatever get_pricing stated, so if fal lowered Kling v3 pro from $0.14 to $0.112 a second, a default job (audio on, $0.168 a second on the model page) was held and booked at $0.1344 a second, about 20% under its bill, with nothing to show it. The basis now says so when it happens: get_pricing's rate, the rate the tiers were decided at, and the model page's rate the job is held at. A raise on get_pricing still scales the ratio up.
A price of $0 from get_pricing is no price: such a job is refused unsent under a cap and, with no cap, booked as an unknown charge, never $0. Before, it was held and booked at $0.
Jobs sent at once on one endpoint share one get_pricing call, and an error or no answer from get_pricing is asked once more before a job is called unpriceable. Before, calls sent together each asked get_pricing, and one error answer among them refused that job under a cap ("its get_pricing answered an error") although the price had just been read for the others.
