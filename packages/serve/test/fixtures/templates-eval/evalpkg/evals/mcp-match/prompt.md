---
description: The agent reads contact 7 from the fake CRM and updates it once; the grader's args match the call.
---
Call mcp__crm__get_contact with {"id": "7"}
Call mcp__crm__update_contact with {"id": "7", "fields": {"score": 80, "note": "fit"}}
Answer:
The CRM said: {{last-result}}
