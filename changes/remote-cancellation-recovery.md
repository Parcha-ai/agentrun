---
packages: repo
kind: fix
---
Keep a remote worker available after a run is stopped: cancel source execution and retire its pending delivery only after the destination confirms cancellation. Preserve durable results and exact delivery retries, and stop on unrelated lease or credential errors.
