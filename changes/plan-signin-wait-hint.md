---
packages: @parcha/agentrun-serve
kind: fix
---
A ChatGPT sign-in that OpenAI never sends back now says why, long before its 10 minutes run out. When a workspace's admin has turned off open-source apps, OpenAI shows its refusal on its own page and never returns to the server. The server can't tell that from a tab left open, so the sign-in sat on waiting for 10 minutes, then said only that it timed out.
- From its first minute on, while OpenAI has sent no code back, GET /settings/chatgpt's pending view carries a `hint`. The hint names the likely cause first: the workspace admin's setting (External access → OSS → Use ChatGPT plan). The console's waiting page shows it under the paste step.
- The timeout's words name the same cause first, then say to start the sign-in again.
