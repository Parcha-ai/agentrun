---
packages: @parcha/agentrun-kernel
kind: fix
---
A capped Claude Code run's wrap-up note goes in the turn's own request. With no small model set, a Claude Code title or summary call goes on the session's model, and such a call could take the note once it was due, so the model never saw it. The model proxy now gives the note only to a request its policy counts as the turn's answer request (`ProviderPolicy.answers`), and a side call goes as its client sent it. A session with no tools offers nothing to tell its requests apart by, so each of its requests still counts as the turn's, as before.
