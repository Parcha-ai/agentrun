# Set up the moves demo

Paste this into your coding agent. It checks what this machine has, tells you what to create, and stops at every step
marked **you run this yourself**. It never runs those, and it never prints a key.

## On fakes: nothing to set up

`npm run demo:moves -- --handoff` runs with no key and no program beyond `node` (Node 22.19 or later): a scripted lead
plays the three agents and the 8 threads, the 8 sandboxes are stand-ins that run local processes, the run lives in a
directory of this machine, and each hand-over starts the next process there.

Check: `node --version` prints v22.19.0 or later.

## A real agent on this machine: `npm run demo:moves -- --live --handoff`

The agents are Anthropic's claude-sonnet-5-5. The run still lives in a directory of this machine, and the threads'
sandboxes are still stand-ins (a thread's own `nvidia-smi -L` will say there is no GPU).

| Env name | What | Where to create it |
|---|---|---|
| `ANTHROPIC_API_KEY` | An Anthropic API key, for the three agents and the 8 threads. | console.anthropic.com: API keys. |

Put it in your environment the way you keep secrets (a secrets manager's run wrapper, or `export` in the shell you run
the demo from). The agent checks that the name is set, never its value.

## On an Archil disk and a Modal VM: the live runner

The run's directory is on an Archil disk, the second process runs on a Modal VM with the disk mounted, and each thread's
tools run in its own Modal H100 sandbox. Everything above, plus:

### Keys

| Env name | What | Where to create it |
|---|---|---|
| `ARCHIL_API_KEY` | An API key of a **scratch** Archil organisation, never a production one: the demo creates and deletes run directories and token users on the disk it is given. | The Archil console, in the scratch organisation: API keys. |
| `PDA_LIVE_DISK` | The disk the run lives on (`dsk-...`), in that organisation, holding nothing else. | The Archil console: create a disk. |
| `PDA_LIVE_REGION` | Optional: the disk's region. Unset means `aws-us-east-1`. | The disk's page in the Archil console. |
| `MODAL_TOKEN_ID` | The Modal token of the runner: it starts the VM and ends every sandbox by its exact id. | The Modal dashboard: Settings, API tokens. |
| `MODAL_TOKEN_SECRET` | The other half of that token. | The same page. |

The model key and the token the VM's session uses to make the 8 sandboxes do not travel from this machine: **you run
this yourself:** in the Modal dashboard, Secrets, create one secret that holds `ANTHROPIC_API_KEY` and one that holds
`MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, and pass their names to the runner (the names, never the values). The VM's
launcher copies those variables into the session's environment by name, and the session removes them from its environment
when it starts. Delete the secrets when you are done.

### Programs

The runner installs these on the VM; this machine needs `node`, and for the first and third process the Archil client.

| Program | What |
|---|---|
| `archil` | The Archil client, 0.8.42 or later. |
| `fusermount` | FUSE, from the `fuse3` package. |
| `archil-scoped` | The disk package's wrapper around the archil client, installed root-owned. It is the one command the run may run as root. |

It refuses without its keys, stops itself after its cap, and ends by deleting every VM and sandbox it made, by exact
id, and the run's directory on the disk.
