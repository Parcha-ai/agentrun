# Anonymous usage counts

AgentRun's server counts how many servers run, so the project knows whether it is used and which versions are. The
counts are anonymous, and one setting turns them off.

**This release sends nothing.** The code is in place and the receiver's key is not set (`TELEMETRY_KEY` in
[`packages/serve/src/telemetry.ts`](../packages/serve/src/telemetry.ts)). The release that sets it says so in its
changelog.

## Turn it off

Set either variable where the server starts:

```sh
AGENTRUN_TELEMETRY=0
DO_NOT_TRACK=1
```

With `npx @parcha/agentrun`, set it in the shell. In a container, set it in the service's environment.

It is also off, with nothing to set:

- in CI (`CI` is set)
- under `--faux`
- in every command but the server's start (`import`, `eval-template`, `runner`, the CLI)

Turned off, the server writes no id and sends nothing.

## See what it would send

```sh
AGENTRUN_TELEMETRY=debug npx @parcha/agentrun
```

Each event is printed on stderr in the form it would be sent, at every start, and none is sent. Debug never replaces
the notice: the first start that can send after it still prints the notice and sends nothing.

## When it sends

| Event | When |
| --- | --- |
| `server_started` | The server starts, from its second start on |
| `heartbeat` | Every 24 hours while the server runs |
| `first_run_completed` | Once per data directory, when its first run completes |

The start that first could send prints a notice on stderr and sends nothing at that start. A server left running sends
its first heartbeat 24 hours after the notice.

## What an event holds

| Field | Example | What it is |
| --- | --- | --- |
| `event` | `server_started` | One of the three names above |
| `distinct_id` | `b8d015a7-…` | A random id made for this data directory, kept in `.telemetry.json` there |
| `timestamp` | `2026-11-17T10:00:00.000Z` | When the event was made |
| `version` | `0.1.0-beta.42` | The server's version |
| `os` | `linux` | Node's `process.platform` |
| `arch` | `x64` | Node's `process.arch` |
| `node` | `24` | Node's major version |
| `runs` | `1-10` | How many runs ended on this data directory, as a range: `0`, `1-10`, `11-100`, `101+` |

Two more fields tell the receiver to keep no profile and to skip the location lookup:
`$process_person_profile: false` and `$geoip_disable: true`.

That is every field. A test (`packages/serve/test/telemetry.test.mjs`) fails when an event holds any other.

## What it never holds

Prompts, messages, workflows, agents, files, keys, tokens, user names, host names, paths, URLs, model names, costs.
The id is random: it is not made from the machine, the user or the network.

The request reaches the receiver from the server's IP address, as any request does. The receiver is set to discard it.

## Where it goes

Events go to `https://telemetry.agentrun.ai`, which forwards them to PostHog, an analytics service, on its US cloud:
the counts are stored in the United States. They land in a
PostHog project that holds these counts and nothing else: it is separate from the projects behind Parcha's products and
websites, so the counts are never joined with an account, a visit or a customer. Parcha, the company behind AgentRun,
reads them as totals: servers running per week, new servers, how many are still running a month later, and versions in
use.

## What it costs the server

Nothing waits on a send. A send has three seconds, a failed one is dropped without a line, and nothing is retried. A
server with no network runs the same. A run's end is counted in memory and written to `.telemetry.json` behind it, so
no request or run waits on the disk.

## What the counts miss

- A server with `--no-runner` counts no runs: separate runner processes send nothing.
- A data directory that does not outlive its container gets a new id at each start.
- Use of the packages as a library, with no server, is not counted.
