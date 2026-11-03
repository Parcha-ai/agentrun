---
packages: repo
kind: feature
---
The console has a webhook page, Settings → Webhook (`#/settings/webhook`), on a server with the webhook routes. It shows the URL run notices are POSTed to, whether its secret signs here, and why it is off when a receiver's 410 turned it off. The signing secret is shown on the save that made it, and never again. A test send says how it went. The last attempts are listed newest first, each with the receiver's answer or why it failed and when it is tried again, and any message of the log can be redelivered under its own `webhook-id`. Settings gains a tab for each of its pages.
