---
packages: repo
kind: ci
---
The Railway and Render walks' waits now tell a timeout by its type and hand the caller what the wait last saw, so the Railway walk's timeout report no longer reads its deployment status back out of the error's words. A change to the timeout's wording can no longer drop the status from the report.
