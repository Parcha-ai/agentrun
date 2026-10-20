# Set up the disk demo

Paste this into your coding agent. It checks what this machine has, tells you what to create, and stops at every step
marked **you run this yourself**. It never runs those, and it never prints a key.

## On fakes: nothing to set up

`npm run demo:disk -- --handoff` runs with no key and no program beyond `node` (Node 22.19 or later): a scripted lead
reviews the invoices, the run lives in a directory of this machine, and the second process opens it there.

Check: `node --version` prints v22.19.0 or later.

## A real agent on this machine: `npm run demo:disk -- --live --handoff`

The agent is Anthropic's claude-sonnet-5-5. The run still lives in a directory of this machine.

| Env name | What | Where to create it |
|---|---|---|
| `ANTHROPIC_API_KEY` | An Anthropic API key, for the review and report agents. | console.anthropic.com: API keys. |

Put it in your environment the way you keep secrets (a secrets manager's run wrapper, or `export` in the shell you run
the demo from). The agent checks that the name is set, never its value.

A run makes about 50 model calls, about $1 to $2 at list price, and stops at `--max-usd`, $3.00 by default. Each
process also stops itself after 60 model calls.

## On Daytona and an Archil disk: `examples/disk/live.ts`

Each process of the run is a Daytona sandbox, and the run's directory is on an Archil disk. Everything above, plus:

### Keys

| Env name | What | Where to create it |
|---|---|---|
| `ARCHIL_API_KEY` | An API key of a **scratch** Archil organisation, never a production one: the demo creates and deletes run directories and token users on the disk it is given. | The Archil console, in the scratch organisation: API keys. |
| `PDA_LIVE_DISK` | The disk the run lives on (`dsk-...`), in that organisation, holding nothing else. | The Archil console: create a disk. |
| `PDA_LIVE_REGION` | Optional: the disk's region. Unset means `aws-us-east-1`. | The disk's page in the Archil console. |
| `DAYTONA_API_KEY` | A Daytona API key for an organisation on Tier 3 or 4: the archil client in the sandbox needs full egress. | The Daytona dashboard: Keys. |

The Anthropic key does not go into a sandbox. **You run this yourself:** in the Daytona dashboard, Secrets, create a
secret that holds your Anthropic key and allows only the host `api.anthropic.com`. Pass its name to the
runner in `DISK_LIVE_SECRET` (the name, never the key), which attaches it to each sandbox as `ANTHROPIC_API_KEY`: the sandbox sees Daytona's placeholder, and Daytona puts
the key into the request when the agent calls Anthropic. Delete the secret when you are done.

### Programs

The runner installs these in each sandbox (from a runtime snapshot, or at boot); this machine needs only `node`.

| Program | What |
|---|---|
| `archil` | The Archil client, 0.8.42 or later. |
| `fusermount` | FUSE, from the `fuse3` package. |
| `archil-scoped` | The disk package's wrapper around the archil client, installed root-owned. It is the one command the run may run as root. |

### The one command

From the repository root, after `npm ci` and `npm run build`, with the keys above in the environment:

```sh
PDA_LIVE=1 PDA_STATE_DIR=$(mktemp -d) DISK_LIVE_SECRET=<your secret's name> node examples/disk/live.ts recording
```

It refuses without its keys, stops itself after 25 minutes, and ends by deleting every sandbox it made and the run's
directory on the disk. The recording is in `recording/`, and its last line says whether the by-code checks passed.
