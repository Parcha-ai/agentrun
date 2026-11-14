---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A pinned call now carries only what it may: a pin can fence an MCP tool's object argument to named keys, and a pinned tool takes only the arguments its listing declares.

Object keys. `{"keys": ["hs_lead_score"]}` on a CRM update's `properties` lets an unattended write set that one field and nothing else.
- The argument, when given, must be an object whose keys are all in the list. Any values are allowed. Leaving it out, or passing `null`, also holds.
- A call that sets another key is refused before it is sent or asked about, under approvals `never` too, and the model reads `properties keys in (hs_lead_score)`.
- When the agent's settings and the server's settings both pin the same argument to keys, only the keys in both are allowed. If no key is in both, every call is refused.
- Templates can fill the keys from parameters (`{keys: ["${parameters.crm_score_property}"]}`). A key whose parameter is not given sets the tool to deny, as an empty pin does today. A key that is a list parameter alone adds each of its items.
- Tool settings and template packages refuse a malformed keys pin with a message. The console shows a keys pin as "properties may hold only the key hs_lead_score (any value)".

Undeclared arguments. Some servers take an alias for an argument their listing never declares: Slack's `channel_id` for `channel`, Gmail's `to` for `recipient_email`. A pin on the declared name could be walked around through the alias.
- A call of a tool with a pin in either layer may carry only the top-level arguments its listing declares under `properties`, plus its pinned ones. The listing is the one the run pinned when it started, the same one its model is offered.
- Any other argument is refused before it is sent or asked about, directly, through `tools_call` and from a codemode script, and the model reads "`to` is not an argument of GMAIL_SEND_EMAIL; a pinned tool takes only its listed arguments (recipient_email is pinned)." Templates no longer need to pin aliases to `null` by hand.
- A listing with no `properties` object closes nothing. Tools with no pin are unchanged.
