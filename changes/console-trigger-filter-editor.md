---
packages: @parcha/agentrun-serve
kind: feature
---
The console sets a webhook's or GitHub trigger's filter, the `accept` rules the API already took, and edits it on a trigger that exists. A rule names an event, the actions it takes (optional) and conditions on the request's body, each a field (a JSON pointer such as `/title`) and one test: "is one of", "starts with", "exists" or "is missing". A request starts a run when any rule takes it.
- New webhook: the filter is optional. With none, every signed request starts a run, as before. With one, each request it takes starts its own run, even while an earlier run is still going, and any other request is answered and starts nothing. Under each event field, the form says what the event is for the webhook's signature: a Standard Webhooks body's `type`, GitHub's `X-GitHub-Event`, or Composio's `metadata.trigger_slug`, whose conditions read the event's data under `/data/`.
- "Is one of" takes one value a line. A number, `true`, `false` or `null` is that JSON value, and so is a line in double quotes (`"42"` is the text 42); any other line is its text. The trigger's page reads each condition back in the same words.
- New GitHub trigger: each picked event takes conditions, and events the picker doesn't list can be added by name.
- A webhook's or GitHub trigger's page has Edit filter. The save changes only the filter: a webhook keeps its URL and secret, and taking its filter away makes every signed request start a run again.
- Editing a filter changes only what you edit. A rule or condition you leave alone is sent back exactly as it was, even one the form would not write itself (a field name ending in a space, an action with a comma in it, a condition on the whole body, rules in another order), and a save with no change sends nothing.
- The form checks each rule's shape and the server's limits (20 rules, 20 conditions a rule, 20 values a list) before it sends. A refusal from the server shows under the field it names, in the server's words.
