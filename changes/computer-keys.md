---
packages: @parcha/agentrun-serve
kind: feature
---
serve maps a computer provider's saved keys, by the names the computer package's kind registry declares, to that provider's create() options (`providerOptions`): E2B's, Orgo's, the phone harness's and Kernel's API key, Daytona's key, URL and target, the Modal token pair and app, and Browserbase's key and project. A name a provider does not declare is never passed on, and a required key not saved is refused in words naming what to save. `testConnection` is Settings' "test connection" over them: the provider made through its module's create(), passed in, then its one account-level read, which never makes a computer. Its coded errors (unauthorized, unreachable, refused, limit, invalid and the rest) come back in plain words with the code kept, and no key value is ever in an answer. Unused until Settings → Computers wires it.
