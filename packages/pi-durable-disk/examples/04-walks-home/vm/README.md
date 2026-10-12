# vm: the Modal VM stop

A Modal VM sandbox the agent moves itself into. The server mints the claim and the supervisor starts the instance there through
`modalHost` (the package), so the VM mounts the disk itself (Modal's VM runtime has `/dev/fuse`, and its fsync survived a daemon kill 10 of
10); `transport: "pipe"` runs the agent through the server's pipe instead, which is what gVisor and GPU sandboxes need.

- `image.ts`: the runtime layer, as Dockerfile `RUN` commands (`vmImageCommands(uid, gid)`): Node 24, the archil client with FUSE, the
  run user `pda`, the app's dependencies, node on the agent's PATH. Compose it on any base: D2's GPU image is the training image plus these.
- `build-image.ts`: build the image on Modal (cached by content) and print its id; `--print-commands` prints the recipe as JSON for a
  builder in another language.
- `desktop.ts`, `scripts/desktop-smoke.ts`: a desktop in the VM (`--cloud-arg desktop=true`, image built with `--desktop`): Xvfb, openbox, x11vnc behind
  noVNC (a person watches in a browser), Chromium, and the agent's `computer` tool (`03-tab-to-cloud/computer-tool.ts`: screenshot, click,
  type, key, scroll over xdotool, a JPEG of the screen after every action). `modalCloud().desktop(ref)` gives the noVNC address and a screenshot.
- `modal-cloud.ts`: `modalCloud()`, the `CloudHost` of the demo server (`serve.ts --cloud-module cloud-module.ts`): environment `modal-vm`, prewarm, start,
  supervise, kill, viewer, and the pipe variant (`startRemote`).

```sh
npm install --no-workspaces --ignore-scripts       # modal, ws
node build-image.ts --app pda-demo [--desktop]      # prints {"imageId":"im-..."}
# from ../03-tab-to-cloud, with MODAL_TOKEN_ID/SECRET and the disk's variables in the environment:
node serve.ts --model M --model-url URL --cloud-module ../04-walks-home/vm/cloud-module.ts --cloud-arg image=im-... [--cloud-arg transport=mount|pipe] [--cloud-arg desktop=true] [--cloud-arg gpu-image=im-...]
node scripts/switch-smoke.ts <run link> modal-vm --back        # a click moves the run there and back
node ../04-walks-home/vm/scripts/agent-switch-smoke.ts <run link>   # the agent moves itself
node ../04-walks-home/vm/scripts/desktop-smoke.ts <run link>        # ... and drives the desktop (desktop=true)
node ../04-walks-home/vm/scripts/gpu-smoke.ts <run link>            # ... trains on a GPU (gpu-image=...) and comes home
```

`npm test` checks the image recipe and the environment's shape; the live behavior is the switch smoke above.

## The whole beat, as a prompt

The agent decides every move; the user says it once, in the tab's chat. The closing words are asked for after the notice at home, so the
story ends at home (the move takes effect after the step that asks for it, so without that sentence the model finishes its answer on the
GPU box before the run leaves):

> I want a walking creature trained. This tab cannot train anything. Move yourself with your switch_environment tool to modal-gpu
> (one-sentence reason), run the training command that your notice there gives you, and wait for it to finish. When home/policy.json
> exists, check its size with bash, then move home with switch_environment (target "tab", a one-sentence reason). After the system
> notice you get once you are home, and not before, tell me in two short lines where you trained and how big the policy file is.

The GPU environment's notice carries what to run (`--cloud-arg gpu-note=TEXT`): D2's trainer is baked in the image, so the note is the
command (`python /opt/pda/train/train.py ... --work train/gpu --minutes 1.0`, then `export.py combine ... --out home/policy.json`).
Measured on an H100 (us-east, gVisor, pipe): first tool call to the notice there 6.8 s, notice to the notice at home 82 s, policy
(442,799 bytes) in the tab's workspace.

## Recording takes (the stage, D5's tooling; local scripts)

- `scripts/take-v2.mjs`: the one take (DEMO-V2): the user draws a creature on the stage's sketcher (D3's `sketch-take.mjs`), types "teach it to walk"
  into the stage's chat, the server places the run on the H100 with a typed question (`placer.ts`; Jev only: the server does not start without its key), the creature learns
  live from each checkpoint, comes home, the user clicks the Wi-Fi control, the network goes off (CDP), two kicks. Starts the take's 03 server
  (`show/scripts/take-server.mjs --modal --cloud-module ... --placer-module ...`), the stage, and in the given Chrome the 03 page (the can-run
  writer) and the stage tab, which it records; writes `<video>.captions.json`, `.results.json` and the policy that came home. The training
  note the GPU notice carries comes from a file (`--gpu-note-file`), the warm-up's compile-only lines from another (`--warm-commands-file`).
  It deletes the run's tree before and after (`scripts/clean-run.ts`). Run `npm run build` in 03, the tab and `show/` first: their bundles are prebuilt.
- `scripts/take-page-v2.mjs`: the docs page of that take (runs `show/publishable.ts` first); `scripts/live-flush-smoke.mjs`: does a file written by a long command reach the disk while it runs.
