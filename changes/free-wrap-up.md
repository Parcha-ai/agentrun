---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: feature
---
A run on a free model is now told when its free-model request limit is near. The request that has 3 requests left (itself included; the limit is 60, or `AGENTRUN_FREE_MODEL_REQUESTS`) carries one note, "3 free-model requests left in this run, this one included: finish now with your answer.", placed the way the spend cap's wrap-up note is, once per run and shown as the server's row in the timeline. Before, the request past the limit was refused with no warning. A paid model's or a ChatGPT plan's requests never count or carry it. When the dollar cap's note is due on the same request, that one goes first.
