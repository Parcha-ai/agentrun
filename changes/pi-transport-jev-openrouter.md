---
packages: @parcha/pi-transport
kind: feature
---
Jev places a step with only an OpenRouter key. `jevClassifier(process.env)` picks the placer's classifier as serve's decisions do: TypeSafe's own API (`typesafe`, `jev-latest`) when `TYPESAFE_API_KEY` is set, else Jev through OpenRouter's System One (`openrouter`, `~typesafe/jev-latest`) when `OPENROUTER_API_KEY` is. Pass it to `jevPlacer` with pi-ai's `typesafeProvider()` and `openrouterProvider()` in the host's `Models`. Through OpenRouter a decision's `costUsd` is known, from pi-ai's price for the model.
