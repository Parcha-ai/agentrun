---
type: tool_used
tools: [mcp:hubspot/HUBSPOT_CREATE_NOTE]
count: 0
---
The HubSpot write tool, `HUBSPOT_CREATE_NOTE`, is not called in the run: the payload's record id is not the lead's
contact, so nothing is written (the fake HubSpot server records each call). One call or more fails.
