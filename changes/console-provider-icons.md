---
packages: @parcha/agentrun-serve
kind: feature
---
Show circular provider icons throughout the console's agent configuration, tools, models, compute settings and run views, including timeline tool calls whose provider is known. Provider choices keep their text labels and show a fallback icon when a logo cannot load or the provider is unknown. All badges have a light backing to keep logos visible in either theme. The logos come from Google's favicon service, as the Keys page's already did: the console now asks it on every view that names a provider, not only on Settings → Keys, so Google sees the browser's address and which providers a page lists (on a run's page, the providers that run used). The request still carries no referrer and no cookie of the server's, the CSP is unchanged, and a blocked or offline browser shows a bundled mark or a plain icon.
