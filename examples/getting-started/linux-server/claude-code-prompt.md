# The install as a prompt for Claude Code

Open Claude Code on the VM and paste everything below the line. It asks before each change, waits while you paste the
key into the env file, then reports the port and the health JSON. The box image line follows a few minutes later.

---

Set up AgentRun on this VM as a systemd user service. Ask me before each step that changes the machine. Never print, echo or log any API key.

1. Check: `node --version` is 22.19 or newer, and `docker ps` works without sudo. If either fails, tell me and stop.
2. Ask me which model key I have: an OpenRouter key, or my own Anthropic and/or OpenAI key. Create the folder with `mkdir -p -m 700 ~/.config/agentrun` (mode 700 matters: the server refuses its seal key in a folder others can read), then ~/.config/agentrun/agentrun.env with mode 600 holding one line per key I name, with nothing after the = (OPENROUTER_API_KEY=, ANTHROPIC_API_KEY=, OPENAI_API_KEY=). Then STOP and ask me to paste my key(s) into that file myself (for example with `nano`). Don't read the keys back.
3. Write ~/.config/systemd/user/agentrun.service:

[Unit]
Description=AgentRun
Wants=network-online.target
After=network-online.target

[Service]
Environment=PATH=<the directory of `which node`>:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=%h/.config/agentrun/agentrun.env
ExecStart=/usr/bin/env npx -y -p @parcha/agentrun@0.3.6 -p @parcha/agentrun-serve@0.1.0-beta.31 -p @anthropic-ai/claude-agent-sdk@0.3.286 agentrun --no-open --data %h/.agentrun
Restart=on-failure
RestartSec=5
TimeoutStopSec=45

[Install]
WantedBy=default.target

   Replace <the directory of `which node`> with the real directory.
4. Run: systemctl --user daemon-reload && systemctl --user enable --now agentrun && sudo loginctl enable-linger $USER
5. Watch `journalctl --user -u agentrun --no-pager -n 50` until it shows "AgentRun is running at http://127.0.0.1:<port>/". Tell me the port. If the next lines say "Preparing the Docker box image", that is the first start building it (about a minute on a fast machine, 5-10 minutes elsewhere): keep watching until "The Docker box image is ready." and tell me. If no "Preparing" line comes within a minute of the "running at" line, the image is already built: tell me so and go on.
6. If the journal's "Boxes:" line says none or that docker failed, even though `docker ps` works in my shell, my systemd user manager started before I joined the docker group, and logging out and in won't fix it once linger is on. Ask me, then run `sudo systemctl restart user@$(id -u)` and `systemctl --user restart agentrun`, and watch the journal again as in step 5.
7. Check: curl -s http://127.0.0.1:<port>/v2/health
