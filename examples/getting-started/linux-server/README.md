# AgentRun on a Linux server or VM

A systemd user service that runs the `npx` line, keeps the model key in a file only you can read, and comes back after
a reboot.

You need: Node 22.19 or newer on the VM (nvm is fine), Docker with your user in the `docker` group (`docker ps` works
without sudo), and ssh from your laptop. Rather hand this to Claude Code? Paste [claude-code-prompt.md](claude-code-prompt.md).

## Install

1. The key file, mode 600. Put your key after the `=` of one line and leave the others empty:

   ```sh
   mkdir -p ~/.config/agentrun ~/.config/systemd/user
   cp agentrun.env.example ~/.config/agentrun/agentrun.env && chmod 600 ~/.config/agentrun/agentrun.env
   nano ~/.config/agentrun/agentrun.env
   ```

2. The unit. Copy [agentrun.service](agentrun.service) to `~/.config/systemd/user/agentrun.service` and replace
   `<node bin>` with the directory `which node` prints. systemd does not load nvm, so that directory has to be on the
   `PATH` line. Running Codex agents? Swap `-p @anthropic-ai/claude-agent-sdk@0.3.286` for `-p @openai/codex@0.164.0`,
   or keep both.

3. Start it, and keep it up after you log out:

   ```sh
   systemctl --user daemon-reload && systemctl --user enable --now agentrun
   sudo loginctl enable-linger $USER
   journalctl --user -u agentrun --no-pager -n 50
   ```

   Watch the journal for `AgentRun is running at http://127.0.0.1:<port>/`; the port is 7340 unless 7340 was busy.
   On the first start with Docker the next lines say `Preparing the Docker box image (first start only, a few
   minutes)...` and, 5 to 10 minutes later, `The Docker box image is ready.` You can make agents meanwhile; a run
   started before the image is ready waits for it, with no spend. No `Preparing` line within a minute means the image
   was already built. Then `curl -s http://127.0.0.1:<port>/v2/health`.

## Open the console and set the password

The console listens on the VM's loopback only. From your laptop:

```sh
ssh -L 7340:localhost:<port> <vm>
```

then open `http://localhost:7340/` and set the owner password, 12 characters or more, before the first run: a learned
note the grader holds back waits for the owner's OK, and only the owner signed in with the password can give it. Then
Settings → Model keys if you would rather add the key there than in the env file, and on to
[../first-agent/](../first-agent/).

## If it goes wrong

- `docker ps` is denied: `sudo usermod -aG docker $USER`, then log out and back in.
- The service fails at once: `journalctl --user -u agentrun -n 50` says why. The usual cause is a `PATH` line without
  node.
- `sudo` asks for a password and you handed the steps to Claude Code: run `sudo loginctl enable-linger $USER` yourself.
  Linger only keeps the service up after logout; the service is already running.
- Node is too old: `nvm install 22`, then update the `PATH` line in the unit.
- Docker can't host boxes on this VM: add `AGENTRUN_BOXES=none` to `agentrun.env`. Agents then run on the server with
  no shell.

## After that

A restart keeps the token, the store, the notes and the password, and a run that was mid-way resumes. Back up
`~/.config/agentrun/seal.key` together with `~/.agentrun`: it opens the keys saved in the console, and a restore
without it asks for them again.

For HTTPS, only after the password is set: Caddy on the VM with `reverse_proxy 127.0.0.1:<port>`, then
`AGENTRUN_PUBLIC_URL=https://<host>` in `agentrun.env` and `systemctl --user restart agentrun`.
