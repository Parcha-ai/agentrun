---
packages: @parcha/agentrun-serve
kind: fix
---
The agent editor's Computer step keeps an agent's image, persistent, GPU, surface, exec and record across a switch of provider or kind, where the new pick can take them, and drops the ones it can't and says so on the kind's card (for example, "The GPU is off: Daytona has no GPUs."). Before, any switch dropped all of them but record. What a pick can take is read from the computers list the console already gets: a provider's images, persistent and gpu, and the kinds that drive or record. A persistent computer is kept wherever the provider lists persistence; whether the default image keeps one isn't served, so it isn't checked.
