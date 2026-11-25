---
packages: @parcha/agentrun-computer
kind: fix
---
An API URL a provider takes is passed on normalized (lower-case scheme and host, a default port such as Modal's `:443` dropped), so `HTTPS://api.modal.com` no longer reaches the Modal SDK's case-sensitive scheme check as an upper-case scheme. A refusal's words give a URL's scheme and host only, never its query, and say nothing of a string that is not a URL. A Groundbox command whose fifo cannot be opened is refused with exit 126 and leaves no directory behind.
