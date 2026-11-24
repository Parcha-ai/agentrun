---
packages: @parcha/agentrun-serve
kind: fix
---
A ChatGPT sign-in is saved as soon as OpenAI answers its code, before its models are listed or the sign-in it replaces is revoked. Before, a server stopped in between left the new sign-in live at OpenAI and saved nowhere. The replaced sign-in now stays in the saved row until OpenAI confirms its revocation. The server's next start lists the models and revokes it again if a stop or an unconfirmed revocation cut that off. A model list OpenAI doesn't answer leaves the fallback list for the next start to replace. Only the server does this; a runner reading the sign-in for a claim never lists models or revokes. A sign-out revokes the replaced sign-ins the row still carries too. Rolling back to an earlier release drops any replaced sign-in the row still carries without revoking it: remove AgentRun in ChatGPT's settings to end it.
