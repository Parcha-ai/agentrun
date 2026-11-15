---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
Signing out of ChatGPT leaves no token alive behind it.
- `DELETE /settings/chatgpt` answers 200 `{"revoked": boolean}` instead of 204. `revoked` is true when OpenAI confirmed the revocation, or when nothing was signed in (cancelling a waiting sign-in). When it is false, `message` says "Signed out here. OpenAI didn't confirm the revocation: remove AgentRun in your ChatGPT settings."
- Sign-out removes the row only while it still holds what it read (`SealedKeys.removeIf`), so a renewal that wrote back meanwhile is removed and revoked too. A renewal that finishes after a sign-out, or loses its write back to a new sign-in, revokes the pair it got and never hands it out. Signing in again revokes the sign-in it replaces.
- The renewal lease is stamped and judged on the store's clock (`SealedKeys.clock`: the database's on Postgres), not each process's own.
- A claim gets the plan's reader only when its run can reach a `chatgpt/` model: an agent pinned to a key's model runs on the key while signed in and never holds the sign-in.
- A runner's redaction lists the sign-in's access and refresh tokens each alone, as renewed by any process. The reader prints its state alone (`util.inspect`, JSON), and the revocation goes only to auth.openai.com.
