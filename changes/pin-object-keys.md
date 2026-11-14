---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A pin can fence an MCP tool's object argument to named keys. `{"keys": ["hs_lead_score"]}` on a CRM update's `properties` lets an unattended write set that one field and nothing else.
- The argument, when given, must be an object whose keys are all in the list. Any values are allowed. Leaving it out, or passing `null`, also holds.
- A call that sets another key is refused before it is sent or asked about, under approvals `never` too, and the model reads `properties keys in (hs_lead_score)`.
- When the agent's settings and the server's settings both pin the same argument to keys, only the keys in both are allowed. If no key is in both, every call is refused.
- Templates can fill the keys from parameters (`{keys: ["${parameters.crm_score_property}"]}`). A key whose parameter is not given sets the tool to deny, as an empty pin does today. A key that is a list parameter alone adds each of its items.
- Tool settings and template packages refuse a malformed keys pin with a message. The console shows a keys pin as "properties may hold only the key hs_lead_score (any value)".
