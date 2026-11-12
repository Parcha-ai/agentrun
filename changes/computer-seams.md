---
packages: @parcha/agentrun-computer
kind: breaking
---
The Browserbase and Kernel providers take no host transport: `BrowserbaseProviderOptions` loses `api` and `urls`, and `KernelProviderOptions` loses `request`, `urls` and `liveUrls`. A provider is built from `apiKey` (and `apiUrl`, `fetch`), always makes its own REST calls and URL stores, and Browserbase always offers profiles and downloads. A caller that passed its own `api`, `request` or URL store uses the REST client instead.
