---
packages: @parcha/agentrun-kernel
kind: fix
---
A model request whose stream opens with the provider's error (a rate limit before any content), and whose client hangs up after reading it, is now booked at $0 as the provider's refusal. Before, the model proxy counted it as a stop the client made and booked the request's hold. A stream that ends in an error only after the client hung up is still a stop.
