---
packages: @parcha/agentrun-serve
kind: feature
---

Show independently running Claude Code and Codex sessions in Connected agents, Runs, and Mission Control with reported model and token/cache usage. Keep observed sessions read-only, preserve their data through temporary refresh failures, and offer existing-application setup through the shared handoff. Keep observed sessions visible through unrelated registered-run loading or failures, label retained session counters separately from range totals, and document confirmed owner-authorized unattended disconnection. Observation reads time out after 30 seconds, cancel when their scope closes, and recover through polling or manual refresh without hiding retained session cards.

Show the complete environment-credential disconnect command, including its required destination origin, in the connector guide and served onboarding skill.
