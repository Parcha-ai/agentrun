# Example 01: a durable chat that survives its host

A chat answers eight scripted messages, one every 1.5 s. After the third answer, host A is powered off: its instance and its
FUSE daemon are SIGKILLed together. Host B's supervisor finds the dead client's claim orphaned, revokes it, and starts a new
instance on host B. The chat goes on from the last committed message, nothing is answered twice, and the final transcript,
read back from the run's store, shows which generation and which host produced each answer.

"Host A" and "host B" are two mount roots on one machine. Each has its own FUSE client, so to Archil they are two machines.

## Run it

You need the Quickstart's setup from the [top-level README](../../README.md#quickstart-on-a-linux-host-kill-a-host-watch-the-run-resume-on-another)
(the root-owned wrapper and the two mount roots, once per machine), a scratch disk and its API key. No model key: the model is
pi-ai's faux provider.

```sh
(cd ../.. && npm ci --ignore-scripts && npm run build)   # once, from the repository root; builds dist/
export ARCHIL_API_KEY=...  ARCHIL_DISK=dsk-...  ARCHIL_REGION=aws-us-east-1
node examples/01-durable-chat/demo.ts    # about 25 seconds
```

The demo creates `runs/chat-<random>/` on the disk, removes it and the run's token users when it ends (`--keep` leaves the
directory), and prints every command it runs. `--help` lists the options.

With Docker instead (no root, no archil client on this machine; build the image as in
[example 02](../02-paid-effect/README.md#with-docker-macos-or-linux-no-root)): `node examples/01-durable-chat/demo.ts --host docker`,
about 30 seconds.

## What you should see

After host A is killed, from the demo's output (it prefixes every line with a time):

```
host A loses power: its instance and its FUSE daemon are killed at once
  fault    kill: sudo kill -s SIGKILL 3402192 3402368   (the processes of the unit and its FUSE scope)

host B: a supervisor on another machine sees the dead client, revokes its claim and starts an instance
  supervise started pda-demo-b-chat-x7k2qa-muy9zk8cyz on host-b (orphaned, revoked 1 delegation)
  chat     generation 2 opened on host-b as uid 1000 (3 messages already answered)
  chat     message 4 answered by generation 2
  chat     message 5 answered by generation 2
  chat     message 6 answered by generation 2
  chat     message 7 answered by generation 2
  chat     message 8 answered by generation 2
  supervise run is done

the transcript, read back from the run's store
    you: What happens to you when your machine dies mid-sentence?
    bot: Message 1 of 8: "What happens to you when your machine dies mid-sentence?" Answered by generation 1 on host-a.
    you: Who decides which machine may write to your store?
    bot: Message 2 of 8: "Who decides which machine may write to your store?" Answered by generation 1 on host-a.
    you: What stops the old machine from writing after the new one starts?
    bot: Message 3 of 8: "What stops the old machine from writing after the new one starts?" Answered by generation 1 on host-a.
    you: Where does your transcript live?
    bot: Message 4 of 8: "Where does your transcript live?" Answered by generation 2 on host-b.
    you: What did you answer to my first question?
    bot: Message 5 of 8: "What did you answer to my first question?" Answered by generation 2 on host-b.
    you: How many of these messages have you seen so far?
    bot: Message 6 of 8: "How many of these messages have you seen so far?" Answered by generation 2 on host-b.
    you: Are you the same process that saw the first one?
    bot: Message 7 of 8: "Are you the same process that saw the first one?" Answered by generation 2 on host-b.
    you: Say goodbye.
    bot: Message 8 of 8: "Say goodbye." Answered by generation 2 on host-b.

generations that answered: 1, 2; messages answered more than once: 0; finished by generation 2
```

Messages 1 to 3 were answered by generation 1, 4 to 8 by generation 2, and none twice.

## What the demo does, by hand

1. **Host A**: the supervisor creates the run directory and starts an instance as a systemd unit with no restarter, like a VM
   that is gone for good:

   ```sh
   ARCHIL_API_KEY=… node dist/cli.js supervise --disk $ARCHIL_DISK --region $ARCHIL_REGION --id $RUN \
       --mount-root /mnt/archil-a --host-name host-a --unit-prefix pda-demo-a- --no-restart --create \
       --lease-expiry 10s --run-arg=--heartbeat-ms=2000 --run-arg=--lease-expiry-ms=10000 --run-arg=--lease-margin-ms=3000 \
       --app $PWD/examples/01-durable-chat/app.ts
   ```

2. After the third answer, power off host A:

   ```sh
   sudo systemctl kill --signal=SIGKILL <unit>.service '<unit>-fuse-*.scope'
   ```

3. **Host B**: the same command with `--mount-root /mnt/archil-b --host-name host-b --every 2s` (and no `--create`). Its first
   pass sees one delegation on `runs/$RUN`, flagged orphaned by Archil, revokes it, and starts an instance. The instance
   mounts the directory at `/mnt/archil-b/runs/$RUN`, opens the store (generation 2), and `onOpen` walks the message list
   from the top: every message already admitted is a no-op (its `requestId` is known), so only the unanswered ones are sent.

Check where a run stands at any time:

```sh
node dist/cli.js status --disk $ARCHIL_DISK --region $ARCHIL_REGION --id $RUN
```

It prints `run.json` (status, generation, the holder's unit and host, the last heartbeat) and the run's delegations. After
the demo (run it with `--keep` to leave the run on the disk) it says `"status":"done"`, `"generation":2`, the `sealedSeq`
of the last commit, and host B as the holder.

## The files

- `app.ts`: the app module `--app` loads: pi-ai's faux provider, the eight messages, and an `onOpen` that submits each with a
  `requestId`. The model's reply names its generation and host.
- `demo.ts`: the orchestration, and `../lib/demo.ts` (shared with example 02).

To use a real model, replace the faux provider in `app.ts` with your provider (see the top-level README's "The app").
