---
type: tool_used
tools: [mcp:hubspot/HUBSPOT_CREATE_CRM_OBJECT_WITH_PROPERTIES, mcp:hubspot/HUBSPOT_PARTIALLY_UPDATE_CONTACT_USING_CONTACT_ID]
count: 2
---
The two HubSpot write tools together are called exactly twice in the run: `HUBSPOT_CREATE_CRM_OBJECT_WITH_PROPERTIES`
once for the note, `HUBSPOT_PARTIALLY_UPDATE_CONTACT_USING_CONTACT_ID` once for the score update (the fake HubSpot
server records each call). Fewer or more calls fail.
