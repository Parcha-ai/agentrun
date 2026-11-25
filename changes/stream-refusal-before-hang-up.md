---
packages: @parcha/agentrun-kernel
kind: fix
---
A model request whose stream opens with the provider's error (a rate limit before any content), and whose client hangs up after reading it, is now booked at $0 as the provider's refusal. Before, the model proxy counted it as a stop the client made and booked the request's hold. A stream that ends in an error only after the client hung up is still a stop. The proxy reads that error from the whole event, so a refusal whose data spans several `data:` lines, or several network chunks, is booked at $0 too. A stream that sends content, then the provider's error, which the client reads before it hangs up, now books the hold, or the usage the provider reported, as it would had the client stayed. Before, it was booked as a stop, by what had streamed.
