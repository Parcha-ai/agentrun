---
packages: @parcha/agentrun-computer
kind: breaking
---
Daytona and Agent37 call their REST APIs through one shared client (`hosted/rest.ts`): the key header, one bound per call, a retry rule the vendor chooses, one HTTP status table, and the cursor-page loop. Breaking, in what an answer means: Agent37 never follows a redirect now (it would carry the key) and reads a 408, 409, 410, 422 or 507 whose body names no code of its own as timeout, invalid, not_found, invalid, limit (it answered `vendor` for all five before); its 402 result remains limit. Daytona reads a 402, or a 507 without quota text, as limit (it answered `vendor` for both). `Agent37Error` no longer carries `status` and its `code` is a ComputerErrorCode.
