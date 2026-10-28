---
packages: @parcha/agentrun-claude-agent
kind: feature
---
A host's skills reach the Claude Agent model: `claudeAgentAdapter({ skills: [{ name, files }] })`. Each session writes them as a local plugin in its own private directory and starts the CLI with that plugin and those skills alone (as `agentrun:<name>`), still with no settings sources, so the CLI's bundled skills and any skill in a home directory are neither listed nor loadable. With skills the model is offered the Skill tool, which the session's tool proxy now lets through; without them it is not. A loaded skill survives a crash: it is part of the history the session store restores. The skills are checked when the adapter is made (`skillProblems`): plain names, a `SKILL.md` whose front matter names the skill and describes it, plain relative paths, 1 MiB in all. A skill's other files are written beside its `SKILL.md`, but with the built-in tools off the model reads only what `SKILL.md` says.
