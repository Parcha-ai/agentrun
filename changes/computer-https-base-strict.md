---
packages: @parcha/agentrun-computer
kind: fix
---
Every provider now refuses an API URL with a user or password, a query or a fragment, since the key goes to it. Before, only Agent37 and Morph refused a query and only Orgo refused credentials; boxd, Browserbase, the Cloudflare relay, Daytona, Groundbox, Kernel, Modal, the phone harness and smol cloud took them without a word. The refusal names the URL's origin alone. A toolbox URL Daytona answers with is held to the same rules.
