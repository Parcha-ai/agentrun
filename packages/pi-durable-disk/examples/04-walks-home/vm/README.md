# vm: the Modal VM stop

A Modal VM sandbox the agent moves itself into. The server mints the claim and the supervisor starts the instance there through
`modalHost` (the package), so the VM mounts the disk itself (Modal's VM runtime has `/dev/fuse`, and its fsync survived a daemon kill 10 of
10); `transport: "pipe"` runs the agent through the server's pipe instead, which is what gVisor and GPU sandboxes need.

- `image.ts`: the runtime layer, as Dockerfile `RUN` commands (`vmImageCommands(uid, gid)`): Node 24, the archil client with FUSE, the
  run user `pda`, the app's dependencies, node on the agent's PATH. Compose it on any base: D2's GPU image is the training image plus these.
- `build-image.ts`: build the image on Modal (cached by content) and print its id; `--print-commands` prints the recipe as JSON for a
  builder in another language.
- `desktop.ts`, `scripts/desktop-smoke.ts`: a desktop in the VM (`--modal-desktop`, image built with `--desktop`): Xvfb, openbox, x11vnc behind
  noVNC (a person watches in a browser), Chromium, and the agent's `computer` tool (`03-tab-to-cloud/computer-tool.ts`: screenshot, click,
  type, key, scroll over xdotool, a JPEG of the screen after every action). `modalCloud().desktop(ref)` gives the noVNC address and a screenshot.
- `modal-cloud.ts`: `modalCloud()`, the `CloudHost` of the demo server (`serve.ts --cloud modal`): environment `modal-vm`, prewarm, start,
  supervise, kill, viewer, and the pipe variant (`startRemote`).

```sh
npm install --no-workspaces --ignore-scripts       # modal, ws
node build-image.ts --app pda-demo [--desktop]      # prints {"imageId":"im-..."}
# from ../03-tab-to-cloud, with MODAL_TOKEN_ID/SECRET and the disk's variables in the environment:
node serve.ts --model M --model-url URL --cloud modal --modal-image im-... [--modal-transport mount|pipe]
node scripts/switch-smoke.ts <run link> modal-vm --back        # a click moves the run there and back
node ../04-walks-home/vm/scripts/agent-switch-smoke.ts <run link>   # the agent moves itself
node ../04-walks-home/vm/scripts/desktop-smoke.ts <run link>        # ... and drives the desktop (serve.ts --modal-desktop)
```

`npm test` checks the image recipe and the environment's shape; the live behavior is the switch smoke above.
