# Get started with AgentRun

Choose where your agents run:

| Option | Start here | Who operates the server |
| --- | --- | --- |
| **AgentRun Cloud** | [Open Cloud](https://console.agentrun.ai/) with an existing account, or [talk to us about access](https://calendly.com/d/dtwn-dsp-nx5/agentrun) | The Grep team |
| **Local** | [Run AgentRun on your computer](../README.md#run-locally-in-three-steps) | You |
| **Self-hosted** | [Deploy on Render or Docker](../README.md#deploy-it) | You, on your infrastructure |

## AgentRun Cloud

Use Cloud to run agents without setting up and maintaining your own server. If you already have an account,
[sign in to AgentRun Cloud](https://console.agentrun.ai/).

For access, team onboarding or deployment requirements, [talk to the team](https://calendly.com/d/dtwn-dsp-nx5/agentrun).
Bring a workflow you want to run and the tools it needs. The team can discuss infrastructure, access and support
requirements with you. Use the setup instructions provided for your workspace.

## Run locally

The open-source platform runs on macOS or Linux with Node 24.22.3 or newer:

```sh
npx @parcha/agentrun
```

It opens a console on your machine and keeps its data in `~/.agentrun`. Set a password, add a model key, and apply a
template to run your first agent. The [three-step local quickstart](../README.md#run-locally-in-three-steps) walks
through a due diligence agent and its results.

To have your coding agent handle local setup, tell it:

> Read https://agentrun.ai/SKILL.md and set up AgentRun locally for me.

## Self-host

Deploy the open-source platform when you want to operate it on your own infrastructure. Start with
[Render or Docker Compose](../README.md#deploy-it), then use the [deployment guide](../deploy/README.md) for runners,
storage, health checks and upgrades. You manage the deployment, its credentials and persistent data.

## Embed workflows in an application

If you want the workflow engine inside your own application, start with the
[workflow guide](guide.md#quickstart) and [host integration](host-integration.md).
