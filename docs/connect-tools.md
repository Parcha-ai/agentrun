# Give an agent tools

Your agent needs a service such as Sentry, GitHub or Slack. Connect the service as an MCP server in the console. Don't
install its CLI in the agent's box with a token. This page gives the order to try, and how to let an unattended agent
use the tools.

## Why the box has no credentials

An agent's shell commands run in a box. The box gets a fixed environment (`PATH`, `LANG`, `LC_ALL`, `TERM`, and
`TMPDIR` and `HOME` when set) and nothing from the server's environment. Network access is limited to package
registries and GitHub (`AGENTRUN_BOX_ALLOW` replaces that list). This is deliberate: an agent reads untrusted text,
such as issues, logs and web pages, and that text can tell it to print or send whatever it can reach. A token kept in
the box is a token the agent can leak.

An MCP server's credential stays outside the box. AgentRun's runner holds it and calls the server for the agent. The
agent sees each tool's result, never the token. Every call passes the run's tool gate, so you decide which calls run,
wait for your approval, or are refused.

## The order to try

### 1. The service's own MCP server, with OAuth

Many services publish a hosted MCP server. Check the service's docs for its MCP address.

1. In the console, open **Settings → MCP servers** and add a server. Linear and Notion are listed as presets.
2. Paste the service's MCP address and choose **Sign in with OAuth**.
3. Sign in on the service's page. AgentRun keeps the tokens, sealed, and refreshes them.
4. Check the tool list the form shows, then save.

Only the owner's signed-in console session can save a credential; the API token cannot. If the service does not let
apps register themselves, the form asks for the client ID and secret of an OAuth app you create with that service.
Details: [Signing in with OAuth](../packages/serve/README.md#signing-in-with-oauth).

### 2. GitHub, through the built-in GitHub App

1. Open **Settings → GitHub** and create the App. GitHub asks you to confirm it and to pick the repositories it may use.
2. Open **Settings → MCP servers**, add a server, and choose **GitHub App**. The address fills in as GitHub's hosted
   MCP server.
3. Save it. The server stores no token.

At each run's start, AgentRun makes a GitHub token that lasts an hour and covers only the run's repository: the one a
GitHub trigger came from, or the first `https://github.com/<owner>/<repo>` in the run's input. A run that names no
repository the App is installed on gets its calls refused, in words. Details:
[GitHub triggers (Connect GitHub)](../packages/serve/README.md#github-triggers-connect-github).

### 3. Composio, for apps without their own MCP server

For an app such as Slack, open **Settings → MCP servers → Add from Composio**. Give your Composio API key, pick the
toolkit and the actions to grant, and save. The result is an ordinary MCP server, gated like any other. Walkthrough:
[Connect Composio tools and triggers](tutorials/composio.md).

### 4. Last resort: your own MCP server on this machine

Use this only when none of the above exists, and only on a machine you alone use: loopback is open to every program
on this machine.

1. Write a small MCP server that runs a fixed set of read-only commands. Don't expose a general shell.
2. Have it listen on `127.0.0.1` and require a bearer token you generate for it.
3. Start AgentRun with `AGENTRUN_MCP_ALLOW_LOOPBACK=1`. Without it, a `127.0.0.1` or `localhost` address is refused.
4. Add the server in **Settings → MCP servers** with its `http://127.0.0.1:<port>/...` address and **Bearer token**.

The CLI's own credential then stays with your server, on this machine, and never enters the box.

## Never do this

- Put a long-lived token (a personal access token, an API key) in the box: in a file, a command or the agent's
  instructions. The agent, and any text it reads, can then use or leak it.
- Widen `AGENTRUN_BOX_ALLOW` so a CLI in the box can reach a service's API with a key. The list is for installing
  packages, not for calling services.

## Let an unattended agent use the tools

An MCP tool with no setting asks: the run stops with `input_required` and waits until you allow or deny the call. That
suits an agent you watch. For an agent on a trigger or a schedule, choose one:

- **Allow specific tools.** In the agent's tool settings, set `mcp:<server>/<tool>` (or `mcp:<server>/*` for a whole
  server) to `allow`. Keep writes on `ask` or `deny` where you can.
- **Allow reads.** Turn on **Allow reads** for a server in **Settings → MCP servers**. Tools the server marks as
  read-only then run without asking.
- **Never ask.** In the agent's editor, set **Approvals** to **Never ask (run unattended)** (`"approvals": "never"`).
  Every call that would ask runs instead. A tool set to `deny` and a template's pins still hold.

Settings reference: [Agents call a server's tools](../packages/serve/README.md#agents-call-a-servers-tools).
