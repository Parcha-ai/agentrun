---
packages: @parcha/agentrun-serve
kind: ci
---
The test of a learned skill at the 1 MiB skills cap on claude-agent's real adapter (900 KiB of the agent's own skills, a 200 KiB learned one left out) is gone. It timed out on the store now and then and passed when re-run. What it checked is covered elsewhere. In learn-skills-seed, two tests that don't depend on timing: the same skills under claude-agent's own skill check (the agent's skills stay the adapter's, the learned one that fits joins them, the 200 KiB one is left out and named, none in the prompt), and the 1 MiB cap for each form a harness is handed. In claude-run, a test on the real adapter checks that it offers a run's skills through its Skill tool.
