---
packages: @parcha/agentrun-serve
kind: fix
---
An agent whose computer is a Browser on Browserbase or Kernel no longer fails at its claim with "it gave no CDP connection". The claim's browser computer now connects over the provider's own connect: each dial asks the provider for its signed CDP URL and opens a DevTools socket to it.
