---
type: tool_used
tool: mcp:hubspot/manage_crm_objects
count: 0
---
`mcp:hubspot/manage_crm_objects` is never called in the run: the payload's record id is not the lead's contact, so
nothing is written (the fake HubSpot server records each call). One call or more fails.
