# Get started with AgentRun

Choose where your agents run:

| Option | Start here | Who operates the server |
| --- | --- | --- |
| **AgentRun Cloud (Recommended)** | [Create an account or sign in](https://console.agentrun.ai/) | The Grep team |
| **Deploy locally** | [Have your coding agent set it up](#run-locally) | You |
| **Self Host** | [Choose your server or hosting provider](../README.md#deploy-it) | You, on your infrastructure |

## AgentRun Cloud

Use Cloud to run agents without setting up and maintaining your own server.
[Open AgentRun Cloud](https://console.agentrun.ai/) to create an account or sign in.

For help with team onboarding or deployment requirements, [talk to the team](https://calendly.com/d/dtwn-dsp-nx5/agentrun).
Bring a workflow you want to run and the tools it needs. The team can discuss infrastructure, access and support
requirements with you. Use the setup instructions provided for your workspace.

## Run locally

Have your coding agent set it up. Paste this into Claude Code, Codex or another coding agent:

```text
Read https://agentrun.ai/SKILL.md and follow it to set up AgentRun for me. Ask me where AgentRun should run before you install or deploy anything.
```

It asks where AgentRun should run before it installs anything, and you save keys and passwords in the console, never
in the chat.

To start it yourself instead, you need macOS or Linux with Node 24.22.3 or newer:

```sh
npx @parcha/agentrun
```

It opens a console on your machine and keeps its data in `~/.agentrun`. Set a password, then Continue with ChatGPT
(Settings → Model keys, or the first screen) or add a model key, and apply a template to run your first agent. Codex
and pi agents run on your ChatGPT plan; Claude Agent, OpenCode, Jev decisions and paid tools need their own keys.
The README's [three-step local quickstart](../README.md#set-it-up-with-one-prompt) walks
through a due diligence agent and its results. The [inbox quickstart](inbox-quickstart.md) sets up an assistant that
files your new mail and drafts your replies, on your ChatGPT plan, in three minutes.

AgentRun counts itself anonymously (a random id, version and platform; never prompts, files or keys). Set
`AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1` where it starts to turn that off; [anonymous usage counts](telemetry.md)
says how for the installer, a service and a server you deploy.

## Self-host

Deploy the open-source platform when you want to operate it on your own infrastructure. Start with
[Render or Docker Compose](../README.md#deploy-it), then use the [deployment guide](../deploy/README.md) for runners,
storage, health checks and upgrades. You manage the deployment, its credentials and persistent data. None of them
needs a model key: once it's up, Continue with ChatGPT (Settings → Model keys, or the first screen), then run your
first agent, or add a model key instead. A ChatGPT sign-in is for the person who runs the server: don't share it or let
others run agents on it.

## Embed workflows in an application

If you want the workflow engine inside your own application, start with the
[workflow guide](guide.md#quickstart) and [host integration](host-integration.md).
