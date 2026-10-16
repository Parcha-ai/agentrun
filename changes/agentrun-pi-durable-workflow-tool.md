---
packages: @parcha/agentrun-pi
kind: feature
---
`@parcha/agentrun-pi/durable` gives a pi-durable session the agentrun tool. `createWorkflowTool(host)` returns one extension that carries the tool and the workflow task: the host installs it and lists the tool's name in the agent definition. Its describe, inspect, dry-run, save, load and list are the coding-agent tool's, run by the same code, over the project store `host.projectDir` names. Its run starts the inspected draft as one background `agentrun.workflow` task of the calling conversation, writes the run's progress to the call's running output, and answers with the outcome. Code nodes run only through the host's `runCode`. `createWorkflowExtension`'s `start` and `read` take a tool's `api` as their caller (`WorkflowCaller`), naming the conversation in `options.conversationId`.
