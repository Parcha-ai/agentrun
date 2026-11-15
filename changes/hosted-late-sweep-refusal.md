---
packages: @parcha/agentrun-computer
kind: fix
---
A hosted computer's create that the caller gave up on, and that the vendor then refuses (`exists`, `limit` or another refusal), no longer deletes the machine under the request's name: that machine belongs to another provider instance's create of the same request. A late failure that may have made a machine (a vendor error or a timeout) is still swept by the name, by the same rule the in-time failure uses.
