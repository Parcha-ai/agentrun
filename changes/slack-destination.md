---
packages: @parcha/agentrun-serve
kind: feature
---
The server posts run notices to Slack itself: paste a Slack incoming-webhook URL under Settings → Slack (or `PUT /v2/settings/slack` with `{url}` from the owner's signed-in session), and each run's end (`run.ended`), each wait on a person (`run.needs_input`) and each trigger that could not start its run (`trigger.failed`) is posted as a readable message: the agent's name, the status in a word, the run's title and a link to the run, what a waiting run waits on, or the trigger's name and error. No relay is needed. A message never carries a run's input, its output or a tool's arguments.
- The URL is the credential, so saving it is a secret write (the API token is refused `403`); it is sealed, never shown again but for its last four characters, kept out of the log and the deliveries, and cut from what a run shows.
- Every event is on by default; `{"events": {"run.needs_input": false}}` turns one off, and the API token may change events.
- Delivery is the outbound webhook's outbox: the same retries, one message per moment, deliveries at `GET /v2/settings/slack/deliveries`, redelivery and a test send (`POST /v2/settings/slack/test`). Slack's `404` or `410` (`no_service`, `channel_not_found`, `channel_is_archived`) turns Slack off with Slack's word until a URL is saved again; a test or redelivery is then `409 slack_off`.
- Only `https://hooks.slack.com/services/...` is taken.
