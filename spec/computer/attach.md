# The attach binding

How the methods of [`wire.md`](wire.md) travel when the computer dials out. A driver on a machine of a person's own
(Computerd on a Mac, a Mac-mini VM's golden image) opens a WebSocket to the server, and the server sends its calls down
it. The machine needs no open port, no SSH and no address the server can reach: it works behind any NAT.

**Status: draft.** The provider's side is in `packages/computer/src/attach.ts` (`AttachHub`, `attachedProvider`,
`socketStreams`), tested over an in-memory socket with the fake ui driver. Serve's routes are not built yet; the list of
what they need is [at the end](#what-serve-needs).

## The socket

- The driver dials `wss://<server>/v2/computers/attach` with its token in the upgrade's `Authorization: Bearer <token>`
  header (never in the URL, which lands in logs) and asks for the subprotocol `agentrun.computer.0.2`, the protocol
  version it speaks. The server answers with the same subprotocol or refuses the upgrade.
- Frames are text, UTF-8. Each frame holds exactly one JSON-RPC message, with no newline after it. A frame holds at most
  `maxLineBytes` bytes ([`protocol.json`](protocol.json)); a bigger one closes the socket with `1009`. A binary frame
  closes it with `1003`.
- The messages are the stdio binding's, unchanged: the same methods, ids, errors, `$/cancelRequest` and limits. Only the
  framing differs: a frame where stdio has a line.
- **The server is the caller.** Once the socket is open, the server sends `hello`, and the driver answers. Then the
  server sends the run's calls. The driver sends replies only; it never sends a request.

## Pairing: bring your own machine

A person pairs a machine once, in about two minutes, and it stays paired until they remove it.

### 1. The console makes a code

On the console's **Computers** page the owner presses **Pair a computer**. The console calls
`POST /v2/computers/pairings` with the owner's session and shows what comes back:

```json
{"code":"K7PD-W3QX","expires_at":"2026-11-12T18:40:00.000Z"}
```

- The code is eight characters a person reads and types: two groups of four, no 0, O, 1 or I
  (`PAIRING_CODE_PATTERN`). It is good once, for 10 minutes (`PAIRING_CODE_TTL_MS`), and belongs to the owner who made
  it. The server keeps its hash, never the code.
- The page shows the code, a countdown, and the driver's download link, and waits: when the code is used, the new
  computer appears on the page with its name and "online".
- A new code for the same owner does not cancel an older one. Each expires on its own, and a used one is gone.

### 2. The app submits it

The person installs the driver (Computerd.app on a Mac), and its first run asks for the code. The app calls
`POST /v2/computers/pair`. This route needs no session: the code is the credential.

```json
{"code":"K7PD-W3QX","name":"Ada's MacBook Pro","hello":{"protocol":"0.2","version":"0.2.0","os":"macos","kind":"desktop","arch":"arm64","groups":["apps","ui","screen","input.pointer","input.keys"],"features":{"ui.tree":true}}}
```

- `name` is what the person calls the machine, which they can edit before sending. The app suggests the OS's own
  computer name.
- `hello` is the driver's own, as it would answer it, so the server records what it pairs: kind, os, groups and
  features. A `hello` of a protocol the server does not take is refused with the words of [the version rule](#versions),
  naming the side to update ("update the driver on Ada's MacBook Pro, then pair with the same code" for an older
  driver), and the code stays good.

### 3. The server issues the credential

The server checks the code: it must exist, be unused and unexpired. It then burns the code and records the computer
under the code's owner, with its name, its `hello` and the time. The answer:

```json
{"computer":"cmp-8f2k3jq7m4xw9tnb","token":"art_4c1f...e93a"}
```

- The computer's id is `cmp-` and 16 lowercase letters and digits: an id an agent's computer setting names as its
  provider, `{"kind":"desktop","provider":"cmp-8f2k3jq7m4xw9tnb"}`.

- The token is the machine's long-lived credential: `art_` and 32 random bytes in base64url, the one shape of
  every machine token, a paired computer's or a hosted machine's; the prefix lets a secret scanner know it. It is shown only in this answer. The app keeps it in the OS's keychain (the macOS login keychain, Android's
  Keystore-backed storage), or, on a box with no keychain, a file only its user can read ([A Linux box](#a-linux-box)),
  and never in a log. The server keeps only its SHA-256.
- It belongs to this one machine: one token per paired computer, never shared. It has no expiry of its own: a machine
  in a drawer for a month still dials back. It ends when the owner removes the computer. A copy on another machine is
  refused there when that machine's `hello` says another kind, os or arch (`4400`); a copy on a machine that says the
  same is not told apart, and each of the two replaces the other's socket (`4409`) until the owner removes the
  computer.
- A wrong, used or expired code is refused `404`, with no word about which of the three, so codes cannot be probed.
  Each source address gets 10 tries a minute. With 32^8 codes (about 1.1 trillion) and a 10-minute life, guessing one is
  out of reach.

The app then dials the attach socket with the token, and the console's page shows the computer online.

### 4. Revoking from the console

On the **Computers** page, each paired computer has **Remove**. Removing calls `DELETE /v2/computers/{id}`. The server
marks the token revoked, ends a run's hold on the machine (the run's next call fails `gone`), and closes the live
socket with `4401` (`AttachHub.revoke`). The app stops dialing and asks for a new code, saying it was removed from the
console. Its next dial with the old token is refused at the upgrade with `401`.

A machine paired again (a reinstalled app, a wiped keychain) gets a new id and token. Its old entry shows offline
until the owner removes it.

### A Linux box

`computerd` is the driver on Linux: `computerd init` serves the protocol on its socket, `computerd pair` trades the
code for the token, and `computerd attach` dials. A box with an X display (`DISPLAY` set for init) pairs as a
`desktop`, with its shell and files. A box with none says `linux` and pairs as a `sandbox`, which holds a run's folder
as a synced folder in its `/workspace` (Mode 2; Mode 1 runs a sandbox only on Docker):

- **A user of its own.** A run's shell runs as computerd's user and can read and write everything that user can, not
  only `/workspace`. The synced folder writes only under `/workspace`; the agent's own commands don't stop there. So
  run computerd as a user made for it, never a person's login user. Make it once, as root:

  ```
  useradd --system --create-home agentrun
  ```

  A run can also leave things under that user that outlive the programs a claim ends: a crontab, systemd `--user`
  units, a line in `~/.bashrc`. A user with no lingering (never `loginctl enable-linger agentrun`) and no crontab is
  how you keep runs from persisting. Every example below runs as `agentrun`.
- **`/workspace`** is a directory of init's user's own, mode `0700`, never a link. Make it once, as root, with a
  tmpfiles.d line naming that user, which makes the directory with that owner and mode, sets them again on one that
  is there, and makes it again at each boot:

  ```
  # /etc/tmpfiles.d/agentrun.conf
  d /workspace 0700 agentrun agentrun -
  ```

  then `systemd-tmpfiles --create /etc/tmpfiles.d/agentrun.conf`. A claim reads it from inside, as init's user, and
  refuses a box whose `/workspace` is missing, a link, not a directory, another user's, or open to its group or others,
  in words naming this fix. The box is let go, and nothing is written.
- **Each claim** ends every program computerd still runs (an earlier run's, left when its hold ended at its deadline:
  KILL to its process group, waited for up to 5 s, the box refused if one outlives it), empties `/workspace` of what
  an earlier run left (each entry removed, a link never followed; the box refused, in words naming what was left, when
  one can't be), then pushes the run's folder in. Each change goes back to the run's folder before the call that made it answers, and once
  more at release, through the claim's epoch fence: a run that has lost the box can't write the folder. The next run
  on the box finds its folder as the run's folder holds it, never as the box was left.
- **Only under `/workspace`.** On a person's own machine the synced folder writes only under its workspace directory,
  never through a link. Init extracts a push opening each name `O_NOFOLLOW` from `/workspace` down, and refuses an
  entry with a link or a file on its way (`entry "escape/x" is outside the target directory: a symlink or a file is on
  its way`). A link the run's folder holds is made as a link, and never followed.
- **Its network** is `open`, the box's own. A sandbox setting with network `none` or an allow list is refused, as for
  every paired computer.

1. **Init.** As `agentrun`, with an empty capability bounding set, which init needs to start as a user who can't
   empty it (a system unit's `CapabilityBoundingSet=`; a user unit can't set it): `computerd init --deadline
   2100-01-01T00:00:00Z`, with `AGENTRUN_COMPUTERD_SOCKET` naming a socket in a directory of that user's alone (0700).
2. **Pair.** With init running, as the same user: `computerd pair https://agentrun.example.com --name build-box`,
   and type the code (or pipe it in: never an argument, since the code is a credential too). The name defaults to the
   hostname. The URL is `https://` (`http://` only on loopback) and pair follows no redirect. One pair runs at a time
   per user (it locks the token file's directory). Pair sends init's own `hello`, as attach will answer it, and writes
   the token to `$XDG_CONFIG_HOME/agentrun/computer.token` (`~/.config` by default; root's is
   `/etc/agentrun/computer.token`):
   created `0600` from its first byte (a file in the same directory made with `O_EXCL|O_NOFOLLOW`, then renamed into
   place), in a directory it makes `0700`. It prints the computer's id, the attach URL and the file, never the token.
   A refused code or `hello` is the server's words, and nothing is written. A box with a token file already is refused
   before anything is sent: `computerd unpair` first.
3. **Attach.** `computerd attach` with `AGENTRUN_ATTACH_URL`, the attach URL pair printed. `AGENTRUN_ATTACH_TOKEN`
   wins when set; else attach reads the file, and refuses, in words, one that is a symbolic link, belongs to another
   user, or is readable by its group or others (it checks the open file, `O_NOFOLLOW`, so what it reads is what it
   checked). A `401` or `4401` says "this machine's pairing was removed or revoked: delete <the file> and pair again".
4. **Unpair.** `computerd unpair` deletes the file. Removing the computer on the server takes the owner's session
   (**Remove** on the Computers page): the machine's token can't, so unpair says so.

As systemd system units, both running as `agentrun`, the token passed through its file and never `Environment=`:

```ini
# /etc/systemd/system/agentrun-computerd.service
[Unit]
Description=AgentRun computer daemon (computerd init)
After=display-manager.service

[Service]
User=agentrun
CapabilityBoundingSet=
NoNewPrivileges=yes
RuntimeDirectory=agentrun
RuntimeDirectoryMode=0700
Environment=AGENTRUN_COMPUTERD_SOCKET=/run/agentrun/computerd.sock
Environment=DISPLAY=:0
# and XAUTHORITY, where that X server asks for one
ExecStart=/usr/local/bin/computerd init --deadline 2100-01-01T00:00:00Z
Restart=always

[Install]
WantedBy=graphical.target
```

```ini
# /etc/systemd/system/agentrun-attach.service
[Unit]
Description=AgentRun computer attach (computerd attach)
Requires=agentrun-computerd.service
After=agentrun-computerd.service network-online.target
Wants=network-online.target

[Service]
User=agentrun
NoNewPrivileges=yes
Environment=AGENTRUN_COMPUTERD_SOCKET=/run/agentrun/computerd.sock
Environment=AGENTRUN_ATTACH_URL=wss://agentrun.example.com/v2/computers/attach
ExecStart=/usr/local/bin/computerd attach
Restart=on-failure
RestartPreventExitStatus=2 3 4 5

[Install]
WantedBy=graphical.target
```

On a box with no display, leave out `After=display-manager.service`, `DISPLAY` and `XAUTHORITY`, and want both from
`multi-user.target`. Start the first, run `computerd pair` as `agentrun` with the same `AGENTRUN_COMPUTERD_SOCKET`, then
enable the second.
Attach's exits 2 to 5 (a missing or refused token file, a removed computer, a `hello` it wasn't paired as, another
protocol version) wait for a person; any other exit dials again.

## Versions

A person's installed app updates on its own schedule, so it can lag the server. The rule:

- **The protocol must be one the server takes: its major, 0.2 or a later minor.** The subprotocol a driver asks for
  (`agentrun.computer.<protocol>`), and the `protocol` in its `hello`, name the protocol version it speaks. From 0.2 on,
  a minor step only adds, and the driver's `hello` groups and features say what it has. The server answers the upgrade
  with its own subprotocol when the driver offers it, else with the first it asked for that works. A 0.1 driver (from
  before 0.2 replaced `apps.ui_tree` with `ui`), a driver of another major, or a version of another shape is refused: at
  the upgrade when no subprotocol it asks for works, else at `hello`, with close code `4426` and words that say what to
  do. An older driver gets "update the
  driver on Ada's MacBook Pro (the download is on the console's Computers page)": the server names no OS and no
  driver app, so the words read the same for every computer, and a driver may add its own way to update when it
  shows them. A newer driver than the server gets "the server is older: it is updated by whoever runs it". The app
  shows these words and stops dialing until it is updated, then dials again on its own.
- **Within the protocols the server takes, any build is accepted.** A newer or older build of the driver (0.2.0, 0.2.3,
  or one speaking 0.3) is the same wire, with more or less of it. The server records the build each `hello` names and shows it on the Computers page.
- **The daemon version check does not apply.** A copied `computerd` must be exactly the provider's version, because
  the provider puts it there and replaces a drifted one. An attached driver is the person's own app, which the provider
  cannot replace, so `attachedProvider`'s `version` is the version of the driver's live `hello`. The drift check then
  compares a version with itself and holds trivially, and the protocol rule above is the only gate.
- **What a driver offers can change with an update.** An updated driver may declare more groups or features. The
  provider's capabilities follow the live `hello`, while kind, os and arch stay what the machine paired as (another is
  `4400`). A Mac's arch alone may change: its driver may move from amd64 under Rosetta to arm64 on the same machine.

## Liveness

- Each side sends a WebSocket ping every 20 s (`ATTACH_HEARTBEAT_MS`) and answers the other's pings. These are
  WebSocket control frames, not JSON-RPC, so the wire is unchanged and a NAT keeps the path open.
- A side that hears nothing for 60 s (`ATTACH_IDLE_MS`), not a message and not a pong, closes the socket with `4408`.
- The server waits 10 s (`ATTACH_HELLO_MS`) for a new socket's `hello` answer. A driver that answers pings but not
  `hello` is closed with `4408`, saying so, and dials again on its own schedule.
- A `hello` without a field the server reads (`protocol`, `version`, `os`, `kind`, `arch`, `groups`) is closed
  with `4426`, naming the fields: the driver is updated, and dials again once it is.
- A `hello` that lacks a group its kind needs to be given to an agent (`kindServed`: a `desktop` with no
  `input.pointer`) is closed with `4426`: "Ada's MacBook Pro says it is a macos desktop but declares no input.pointer,
  input.keys: update the driver on Ada's MacBook Pro (…)". Pairing refuses the same `hello` in the same words. The
  conformance case `health.kind-served` fails such a driver before it ships.
- A computer has one socket. When the same computer dials again (its network changed and the old socket is half dead),
  the server keeps the new socket and closes the old one with `4409`. New means dialed later, whichever `hello`
  answers first: a socket whose `hello` ends after a socket dialed later went live is closed with `4409` too.

## Close codes and redialing

| Code | Why | The driver |
| --- | --- | --- |
| `1000` | Closed on purpose. | Dials again. |
| `1001` | The server is restarting, or the driver is quitting. | Dials again. |
| `1003`, `1009` | A binary frame; a frame over the limit. | Dials again. |
| `4400` | Its `hello` is not what it paired as: another kind, os or arch. | Stops: the person pairs it again. |
| `4401` | Its token is unknown or revoked. | Stops: the person pairs it again. |
| `4408` | Nothing heard for 60 s. | Dials again. |
| `4409` | The same computer dialed again. | Dials again (the newer socket is already up). |
| `4426` | It speaks a protocol the server does not take ([Versions](#versions)), or its `hello` lacks a group its kind needs. | Stops: the person updates the driver. |

Any other code, or a drop with none (`1006`), is redialed. A driver waits 1 s before its first redial, doubling each
time to at most 60 s, less up to a fifth at random so a fleet that lost the server together does not return together
(`redialDelay`). A socket that stayed up for 60 s resets the count.

## A drop, and what was in flight

- **On the server.** Every call still waiting on the socket fails at once with the error code `gone`. The server never
  sends a call again on the next socket: a step may have run before the drop, so a call runs at most once. A run that
  needs the step observes again and decides.
- **On the driver.** Every request still running is cancelled, as when the stdio binding's input ends. An act stops
  between steps; what already ran stays done.
- **Refs and states** are a connection's own, and a new socket is a new connection: a ref from before the drop is refused
  `invalid`, and the caller observes again. What runs on the machine (its apps, their windows) is untouched.

## The server's side: the provider `attached`

The server maps an attached computer to a provider so a run takes it like any other computer.

- **One connection.** `AttachHub.accept(paired, socket)` calls `hello` on a new socket and keeps it when the `hello` is
  what the computer paired as (same kind, os and arch, this protocol version). Every caller in the server shares that one
  connection: one run holds the computer at a time, so its refs and states are that run's.
- **A provider per paired computer.** `attachedProvider(paired, hub)` is a `ComputerProvider` with id `attached`. Its
  capabilities are the computer's kind and os as it paired, the groups of its live `hello`, network as the machine has
  it, and isolation `machine`. A desktop's or a phone's daemon mode is `none`: no `computerd init` runs on the machine,
  so none of init's promises about programs hold, and `exec` and `files` are groups it may declare but not Core, and an
  attached Mac declares them only by its owner's grant ([`kinds.md`](kinds.md)). A Linux box's is `child` (init runs
  there, under its service manager), with no vendor agent ports (attach dials out) and the synced folder as its one
  mount, read back as `{ kind: "sync", epoch }` under the run's claim epoch ([A Linux box](#a-linux-box)).
- **Claim, not make.** `create` claims the computer for a run, with the run's labels: refused `gone` while it is not
  attached, `refused` while another run holds it. `release` with `delete` ends the run's hold and deletes nothing;
  `stop` is refused. A person's machine is never made, stopped or deleted by a run. A run's hold ends at its
  `lifetimeMs`, released or not: there it ends as a release does (the run's connections close, the next run may
  claim) and the machine runs on. An agent's hold (`owner`) has no deadline.
- **A run's ref names its hold.** `create` answers `<computer id>.<hold>`, a ref of this hold and no later one.
  `release` with it ends only that hold: once the hold has ended, a late release ends nothing, and the hold on the
  computer now (another run's) stays. `connect` and `attach` with an ended hold's ref are refused `gone`. `release`
  of the computer's own id is `invalid`.
- **A run's connection outlives a redial.** Its calls go over the socket that is live when each is made: while the
  computer is away they fail `gone`. A new socket is a new session whose refs, states and handles are its own, and an
  old one could name something else there: the first call after a redial is refused `gone` without running, saying
  the computer dialed back, and the calls after it go over the new socket (so the run observes again).
- **A run's connections end with its hold.** Each `connect` gives a connection over the one socket. Closing it, or the
  run's release, cancels its calls still running and refuses its later ones `gone`, so a run done with the computer
  cannot reach it once another run holds it.
- **Its network is its own.** A run asks for network `open`; `none` or an allow list is refused at `create` and at
  `network`, because a run cannot block or limit a person's machine.
- **Lists and attach** find it by its id, or by its own labels with the holding run's.
- **The policy** (which apps a run may use, which routes) stays the server's, as for every computer: the driver offers
  what its `hello` declares, and the server's claim narrows it.

## Hosted machines that dial

A vendor that boots an image with env, and has no two-way exec, makes machines that dial this socket instead of being
reached ([`provider.md`](provider.md#a-hosted-vendors-exec), facts `connect: "dial"`). Its computers are a hosted
provider's, made and deleted by runs; only the transport is this binding's.

- **Mint.** `create` mints the machine its own token (`MachineTokens.mint` in `src/attach.ts`): `art_` and 32 random
  bytes in base64url, for the computer's name, kind, os and arch. The store keeps only its SHA-256. It expires at the
  computer's `backstopAt` (its deadline cap plus the backstop margin), so a machine the janitor never reaches stops
  dialing then at the latest.
- **Boot env.** The vendor's create gives the machine the boot env: these names, in the machine's env or, for a
  provider that starts `agentrun-dial` itself, the URL on its start; nothing else is run in it: `AGENTRUN_ATTACH_URL`
  (`wss://<public host>/v2/computers/attach`; `ws://127.0.0.1` only in tests),
  `AGENTRUN_ATTACH_TOKEN`, `AGENTRUN_DAEMON_URL` (`https://<public host>/v2/computers/daemon?arch=<amd64|arm64>`),
  `AGENTRUN_DAEMON_SHA256` (the build the server serves for that arch), `AGENTRUN_INIT_ARGS` (init's arguments, as
  a start passes them, space-separated), for a desktop, `DISPLAY` (`:0`), and, with an attach egress,
  `AGENTRUN_ATTACH_EGRESS` (`<IPv4 relay>:<port>`, the operator's relay for machines that reach listed addresses
  alone). Daytona hands `AGENTRUN_ATTACH_URL` to its start; the token is always the env's, never on a command line.
  The image's `agentrun-dial` fetches the daemon, refuses it unless its SHA-256 is that one, starts
  `computerd init` with an env that holds no token (and `DISPLAY`, when given), and runs `computerd attach` with the
  URL and token alone, and the egress when given. With an egress, the fetch and every dial open TCP to the relay and
  speak TLS and HTTP to the public host through it: the SNI, the certificate checked and `Host` are the public host's,
  and the relay never terminates TLS. A desktop's X server and window manager start after it dials, through
  `process.start` over its socket, as on a machine reached by exec.
- **The daemon route.** `GET /v2/computers/daemon?arch=` takes the token as the attach upgrade does and answers the
  server's own `computerd` for that arch, at most 10 a minute per token (`429` past it).
- **The upgrade.** A minted token the store doesn't hold, revoked or past its expiry is `401` before the upgrade. A
  minted socket goes to the hub under the computer's name, a paired computer of its mint (`mintedComputer`); a `hello`
  of another kind, os or arch is closed `4400` (its token is that machine's alone), and one of another build `4400`.
  One exception: a machine minted kind `desktop` may say kind `linux`, on exactly the os and arch it was minted for,
  as it does until its display answers. The hub keeps the `hello` it said, never the token's kind. A paired computer
  (not minted) has no such exception.
- **Delete.** `release` with `delete`, the provider's own failed create and a machine that never dials within
  `createMs` (create fails `timeout`, naming the URL it was given) all revoke the token and close the socket. So does
  one whose dial the server refused in words it kept for the token (`MachineTokens.refused`; serve keeps a relay it
  could not make to the runner that minted the token): create fails `refused` in them at once.
- **Never logged.** The token sits in the machine's env and in the `Authorization` header. Neither serve nor `computerd`
  writes it to a log, a URL or an error.

## What serve needs

Built in serve: the routes and the socket in `computer-attach.ts`, the provider in `workspace/attached-computers.ts`
(a paired computer is one more provider of the kind registry, named by its id), the claim in `computer-for-claim.ts`,
the page in the console's Settings → Computers. Where it differs from the list below: a server has one owner, so the
tables have no owner column; the code's expiry is `expires_at`; and the page has no download link yet. The end-to-end
test is `packages/serve/test/computer-attach-e2e.test.mjs`.

1. **A store table** of paired computers: id, owner, name, the `hello` it paired as, the driver build of its last
   `hello`, labels, the token's SHA-256, created and last-seen times, and a revoked flag. Pairing codes: the code's
   hash, owner, expiry and used. A rate limit on `POST /v2/computers/pair` by source address.
2. **Routes** in `computers.ts`, with their OpenAPI entries and the regenerated clients:
   `POST /v2/computers/pairings` (owner: a new code), `POST /v2/computers/pair` (driver: code for token),
   `GET /v2/computers/attach` (the WebSocket upgrade: check the token's hash and the subprotocol, then
   `AttachHub.accept`), `GET /v2/computers` listing paired computers with online or offline, and
   `DELETE /v2/computers/{id}` (remove: revoke the token, `AttachHub.revoke`).
3. **The socket**: an `AttachSocket` over serve's WebSocket server, which sends and answers pings and closes on idle,
   binary and oversize frames with the codes above.
4. **Resolve and claim**: `resolve-computer.ts` builds `attachedProvider` for a computer setting that names a paired
   computer; `computer-for-claim.ts` claims it (`create`) for the run and releases it at the run's end.
5. **More than one serve process**: a computer's socket lands on one process. Until claims route to the process that
   holds the socket, attached computers need serve to run as one process, or a sticky route by computer id. Built: the
   runner beside the server shares its `AttachHub`; a runner of its own process refuses a paired computer at the claim
   in words that say so.
6. **The console**: a "pair a computer" page that shows the code and the paired computers, online or offline.

## Open questions

- **A Mac-mini VM** dials out the same way, with a token baked into its golden image and revoked when the VM is
  deleted. Whether that token is per image or per VM is the pool's call.
