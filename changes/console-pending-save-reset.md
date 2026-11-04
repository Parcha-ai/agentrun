---
packages: repo
kind: fix
---
The console's agent editor keeps a tool provider change made while a save is under way, a reset included. Before, picking a provider, saving, and resetting it before the save came back lost the reset: the form showed the saved provider again, and another save couldn't undo it.
