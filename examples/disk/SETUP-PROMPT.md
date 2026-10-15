# Set up the disk demo

Paste this into your coding agent. It checks what this machine has, tells you what to create, and stops at every step
marked **you run this yourself**. It never runs those, and it never prints a key.

## On fakes: nothing to set up

`npm run demo:disk` runs with no key and no program beyond `node` (Node 22.19 or later): the run lives in a directory of
this machine, and the kill is a `kill -9` and a local resume.

Check: `node --version` prints v22.19.0 or later.

## Live: `npm run demo:disk -- --live`

Linux only: the run's directory is mounted from an Archil disk through FUSE. On macOS or Windows the key check says so
before anything starts.

### Keys

| Env name | What | Where to create it |
|---|---|---|
| `ARCHIL_API_KEY` | An API key of a **scratch** Archil organisation, never a production one: the demo creates and deletes run directories and token users on the disk it is given. | The Archil console, in the scratch organisation: API keys. |
| `PDA_LIVE_DISK` | The disk the run lives on (`dsk-...`), in that organisation, holding nothing else. | The Archil console: create a disk. |
| `PDA_LIVE_REGION` | Optional: the disk's region. Unset means `aws-us-east-1`. | The disk's page in the Archil console. |

Put them in your environment the way you keep secrets (a secrets manager's run wrapper, or `export` in the shell you run
the demo from). The agent checks that each name is set, never its value.

### Programs

| Program | What |
|---|---|
| `archil` | The Archil client, 0.8.42 or later. |
| `fusermount` | FUSE, from the `fuse3` package. |
| `archil-scoped` | This package's wrapper around the archil client, installed root-owned. It is the one command the run may run as root. |

**You run this yourself:** install the Archil client and FUSE, with your package manager and `sudo`, from Archil's
install instructions for your distribution (a `.deb` on Debian and Ubuntu), and `fuse3`.

**You run this yourself:** install the wrapper root-owned, then add the one sudoers line for it, checked before it is
installed. From the repository root, with `<you>` your user name:

```sh
sudo install -o root -g root -m 0755 packages/pi-durable-disk/bin/archil-scoped /usr/local/sbin/archil-scoped
echo '<you> ALL=(root) NOPASSWD: /usr/local/sbin/archil-scoped' > /tmp/pi-durable-disk.sudoers
sudo visudo -cf /tmp/pi-durable-disk.sudoers && sudo install -o root -g root -m 0440 /tmp/pi-durable-disk.sudoers /etc/sudoers.d/pi-durable-disk
```

Check: `archil --version` prints 0.8.42 or later, `command -v fusermount` finds it, and
`sudo -n /usr/local/sbin/archil-scoped version` runs without asking for a password.

### The one command

```sh
npm run demo:disk -- --live
```

## Live with the kill: `npm run demo:disk -- --live --kill`

The run lives in a Daytona sandbox. Right after a paid tool call is acknowledged, the demo deletes that sandbox; the
claim on the disk is revoked, and a new sandbox takes the run over. Everything in the live section above, plus:

| Env name | What | Where to create it |
|---|---|---|
| `DAYTONA_API_KEY` | A Daytona API key for an organisation on Tier 3 or 4: the archil client in the sandbox needs full egress. | The Daytona dashboard: Keys. |

```sh
npm run demo:disk -- --live --kill
```

A live run costs about $0.15 at list prices: a few sandbox minutes and about 10 model calls. It stops at
`--max-usd`, $0.30 by default. With the shared ChatGPT sign-in, your plan pays for the model calls.
