---
packages: @parcha/agentrun-computer
kind: breaking
---
Daytona and Agent37 call their REST APIs through one shared client (`hosted/rest.ts`): the key header, one bound per call, a retry rule the vendor chooses, one HTTP status table, and the cursor-page loop. Breaking, in what an answer means: Agent37 never follows a redirect now (it would carry the key) and reads a 402, 408, 409, 410, 422 or 507 whose body names no code of its own as limit, timeout, invalid, not_found, invalid, limit (it answered `vendor` for all six before); Daytona reads a 402 as limit (it answered `vendor`). `Agent37Error` no longer carries `status` and its `code` is a ComputerErrorCode.
