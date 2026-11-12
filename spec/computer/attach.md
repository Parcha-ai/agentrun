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

## Pairing and the token

A computer is paired once and keeps its token.

1. **A code.** The owner asks the console (or `POST /v2/computers/pairings`) for a pairing code. It is eight characters
   a person reads and types, `K7PD-W3QX` (no 0, O, 1 or I), good once, for 10 minutes.
2. **The trade.** The driver sends the code to `POST /v2/computers/pair`, with a name for the machine and its own
   `hello` (`PairRequest`). The server checks the code, burns it, records the computer under the code's owner with
   what its `hello` said (kind, os, groups, features), and answers the computer's id and a token (`PairResult`).
3. **The token.** It is a secret of 32 random bytes, shown once. The driver keeps it in the OS's keychain; the server
   keeps only its hash. It does not expire on its own: it lasts until the owner removes the computer, which revokes it.
   A revoked token's socket is closed at once with `4401`, and its next dial is refused.

A machine paired again (a reinstalled driver) gets a new id and token; the owner removes the old one.

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
| `4426` | It speaks another protocol version. | Stops: the person updates the driver. |

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
- **A provider per paired computer.** `attachedProvider(paired, hub)` is a `ComputerProvider` with id `attached` whose
  capabilities are what the computer paired as: its kind, os and groups, network as the machine has it, isolation
  `machine`. It has no init of ours, so its daemon mode is `none`.
- **Claim, not make.** `create` claims the computer for a run, with the run's labels: refused `gone` while it is not
  attached, `refused` while another run holds it. `release` with `delete` ends the run's hold and deletes nothing;
  `stop` is refused. A person's machine is never made, stopped or deleted by a run.
- **Lists and attach** find it by its id, or by its own labels with the holding run's.
- **The policy** (which apps a run may use, which routes) stays the server's, as for every computer: the driver offers
  what its `hello` declares, and the server's claim narrows it.

## What serve needs

These touch files under the current hold (serve's `computers.ts`, `openapi.ts`, `resolve-computer.ts`,
`computer-for-claim.ts`, the generated clients) and land when it lifts:

1. **A store table** of paired computers: id, owner, name, the `hello` it paired as, labels, the token's hash,
   created and last-seen times, and a revoked flag. Pairing codes: the code's hash, owner, expiry, used.
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
