---
packages: repo, @parcha/agentrun, @parcha/agentrun-client
kind: fix
---
The CLI and the clients say what the server does:
- A list command (`agents list`, `runs list`, `files list` and every other that takes `--cursor`) takes `--all`: it follows `next_cursor`, prints every page as one list with `next_cursor` null, and stops with exit 1, printing nothing, on a cursor the server answers twice or past 1000 pages. The skill's command reference lists it on each.
- A 501 exits 5, not 1: the server does not offer the command here (`unsupported_here`). The error printed is the server's, with its reason and `status: 501`; a body with no message gets one naming the capability that is off. A request that carries a secret says it in the CLI's own words, as its other refusals do.
- A run waiting on its spend cap is said to be paused at it, in `runs wait`'s line and in the skill, never stopped.
- A streamed download (`readFile(..., { stream: true })` in TypeScript, `read_file(..., stream=True)` in Python, `parcha-agentrun`) that fails while its body is read (the call's timeout passes, or the body is cut before its length) rejects or raises `AgentRunUnreachable` with the failure's code, never the platform's own error. It is not tried again: what was read is the caller's.
- `npx @parcha/agentrun` on too old a Node names the real floor, Node.js 24.11, read from the package's `engines` field so the two can't drift apart. It used to say "22.19 or newer on 22, or 24.2 or newer". The setup skill (docs/SKILL.md) says 24.11 too.
