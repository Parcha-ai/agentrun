---
packages: @parcha/agentrun-serve
kind: fix
---
A desktop or phone run gets its kind's skill again. The claim read the computer kind from the run's launch, which never carries it, so no run since the store cutover had `.agents/skills/desktop-computer/` or `.agents/skills/phone-computer/`, and a read of either answered ENOENT. Now the kind comes from the agent's computer setting, the one the claim starts the computer from. The skill is laid beside the revision's own skills and named the same way: pi's system prompt lists it, and Codex, Claude Code and OpenCode get it as one of their own skills (or in the prompt, where the harness refuses it).

A phone run's refusal and ask now say phone. A computer tool is still held to the stricter of the desktop and phone settings, and the words name the setting that decided the call, which is the run's own kind when both say the same. Before, a phone run with phone set to deny was refused with "Permission denied: desktop is set to deny for this agent.", and its approval was asked as desktop.

The phone skill's scroll is now a point scroll on a call with `foreground: true`, because a swipe is the phone's own input and the phone refuses it otherwise. Its script scrolls Settings until About phone shows, then expects "Device name", which is on screen after the press. The old expect, "Android version", is below the fold, so it never showed.
