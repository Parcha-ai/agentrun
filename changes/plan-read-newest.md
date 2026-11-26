---
packages: @parcha/agentrun-serve
kind: fix
---
Two reads of the ChatGPT sign-in that overlap no longer answer oldest last. Before, a server could read signed in again after it had found the sign-in expired (another process's renewal refused for good), until its next read. Now the newest read's state stays.
