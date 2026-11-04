---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose `file_ids` holds something that is not a file id is now told what it sent and where a file id comes from: `file_ids[0] is "", not a file id: use the file_id an upload answered (POST /v2/files answers it under file.file_id).`, where it said `file_ids[0] is a file id`. What was sent shows as its JSON, cut to 40 characters (never inside a surrogate pair). The README and llms.txt say the upload's answer holds the id under `file`.
