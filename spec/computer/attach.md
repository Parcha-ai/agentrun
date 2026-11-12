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
{"code":"K7PD-W3QX","expiresAt":"2026-11-12T18:40:00Z","download":"https://<server>/downloads/computerd"}
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
  features. A `hello` of another protocol version is refused with the words of [the version rule](#versions), and the
  code stays good.

### 3. The server issues the credential

The server checks the code: it must exist, be unused and unexpired. It then burns the code and records the computer
under the code's owner, with its name, its `hello` and the time. The answer:

```json
{"computer":"cmp_8f2k3j","token":"art_4c1f...e93a"}
```

- The token is the machine's long-lived credential: 32 random bytes, prefixed `art_` so a secret scanner knows it. It
  is shown only in this answer. The app keeps it in the OS's keychain (the macOS login keychain, Android's
  Keystore-backed storage) and never in a file or a log. The server keeps only its SHA-256.
- It belongs to this one machine: one token per paired computer, never shared. It has no expiry of its own: a machine
  in a drawer for a month still dials back. It ends when the owner removes the computer.
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

## Versions

A person's installed app updates on its own schedule, so it can lag the server. The rule:

- **The protocol version must be the server's.** The subprotocol a driver asks for, and the `protocol` in its `hello`,
  name the protocol version it speaks. A driver of another version is refused: at the upgrade when the subprotocol
  differs, else at `hello`, with close code `4426` and words that say what to do. An older driver gets "update the
  driver on Ada's MacBook Pro (Computerd: its menu's Check for Updates, or the download on the console's Computers
  page)". A newer driver than the server gets "the server is older: it is updated by whoever runs it". The app shows
  these words and stops dialing until it is updated, then dials again on its own.
- **Within one protocol version, any build is accepted.** A newer or older patch of the driver (0.2.0, 0.2.3) is the
  same wire. The server records the build each `hello` names and shows it on the Computers page.
- **The daemon version check does not apply.** A copied `computerd` must be exactly the provider's version, because
  the provider puts it there and replaces a drifted one. An attached driver is the person's own app, which the provider
  cannot replace, so `attachedProvider`'s `version` is the version of the driver's live `hello`. The drift check then
  compares a version with itself and holds trivially, and the protocol rule above is the only gate.
- **What a driver offers can change with an update.** An updated driver may declare more groups or features. The
  provider's capabilities follow the live `hello`, while kind and os stay what the machine paired as (another is
  `4400`).

## Liveness

- Each side sends a WebSocket ping every 20 s (`ATTACH_HEARTBEAT_MS`) and answers the other's pings. These are
  WebSocket control frames, not JSON-RPC, so the wire is unchanged and a NAT keeps the path open.
- A side that hears nothing for 60 s (`ATTACH_IDLE_MS`), not a message and not a pong, closes the socket with `4408`.
- A computer has one socket. When the same computer dials again (its network changed and the old socket is half dead),
  the server keeps the new socket and closes the old one with `4409`.

## Close codes and redialing

| Code | Why | The driver |
| --- | --- | --- |
| `1000` | Closed on purpose. | Dials again. |
| `1001` | The server is restarting, or the driver is quitting. | Dials again. |
| `1003`, `1009` | A binary frame; a frame over the limit. | Dials again. |
| `4400` | Its `hello` is not what it paired as: another kind or os. | Stops: the person pairs it again. |
| `4401` | Its token is unknown or revoked. | Stops: the person pairs it again. |
| `4408` | Nothing heard for 60 s. | Dials again. |
| `4409` | The same computer dialed again. | Dials again (the newer socket is already up). |
| `4426` | It speaks another protocol version ([Versions](#versions)). | Stops: the person updates the driver. |

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
  what the computer paired as (same kind and os, this protocol version). Every caller in the server shares that one
  connection: one run holds the computer at a time, so its refs and states are that run's.
- **A provider per paired computer.** `attachedProvider(paired, hub)` is a `ComputerProvider` with id `attached`. Its
  capabilities are the computer's kind and os as it paired, the groups of its live `hello`, network as the machine has
  it, and isolation `machine`. Its daemon mode is `none` for now (see the open questions).
- **Claim, not make.** `create` claims the computer for a run, with the run's labels: refused `gone` while it is not
  attached, `refused` while another run holds it. `release` with `delete` ends the run's hold and deletes nothing;
  `stop` is refused. A person's machine is never made, stopped or deleted by a run.
- **Lists and attach** find it by its id, or by its own labels with the holding run's.
- **The policy** (which apps a run may use, which routes) stays the server's, as for every computer: the driver offers
  what its `hello` declares, and the server's claim narrows it.

## What serve needs

These touch files under the current hold (serve's `computers.ts`, `openapi.ts`, `resolve-computer.ts`,
`computer-for-claim.ts`, the generated clients) and land when it lifts:

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
   holds the socket, attached computers need serve to run as one process, or a sticky route by computer id.
6. **The console**: a "pair a computer" page that shows the code and the paired computers, online or offline.

## Open questions

- **The daemon mode.** An attached driver is neither `computerd init` (it keeps none of init's promises about
  programs, because it runs none) nor a provider answering itself. It declares `none` today, which gives the right Core
  groups. A mode of its own, `driver`, would say it plainly; it is a change to `DaemonMode` and the kind table.
- **A Mac-mini VM** dials out the same way, with a token baked into its golden image and revoked when the VM is
  deleted. Whether that token is per image or per VM is the pool's call.
