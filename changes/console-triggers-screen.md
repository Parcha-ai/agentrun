---
packages: repo
kind: feature
---
The console's Schedules page is now Triggers (#/triggers): it lists every trigger with its kind, and makes webhooks as well as schedules. A new webhook shows its URL and signing secret once, each with Copy and "You won't see this secret again."; a retry under the same Idempotency-Key shows the server's note in the secret's place. A webhook's page shows its URL, its signature scheme and its firings ("On a request"), and Rotate secret asks first, then shows the new secret once. A create (schedule or webhook) sends an Idempotency-Key per request, so a create sent again unchanged makes one trigger and an edited one gets a new key. Refusals show in the server's words.
