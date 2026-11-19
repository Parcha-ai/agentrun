---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
The outbound webhook's signing secret can be rotated for the same URL: `POST /v2/settings/webhook/secret`, and Rotate secret in the console's Settings → Webhook, which asks first and then shows the new secret once, in the same box a save shows it in, with Copy secret, and moves the focus to it. It is a secret write, so only the owner's signed-in session may make it; the API token gets the same 403 as every other secret write, and the secret is kept. The old secret is retired at once: every try after the rotation is signed with the new one, a message queued before it included, so the receiver needs the new secret before its next message. `404` when no webhook is set; `422` for any body. A `PUT` with the API token now tells the person to rotate the secret in the console, in place of removing the webhook and saving it again.
