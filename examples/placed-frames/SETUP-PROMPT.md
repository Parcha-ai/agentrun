# Set up Placed Frames for a live run

Paste this into your coding agent. It sets up `npm run demo:placed -- --live`. A run with no key (`npm run demo:placed`) needs only node.

You are in a checkout of the agentrun repository. Do these steps in order and stop to ask me at any step that needs a decision or a secret.

1. Run `node --version`. It must be 22.19 or newer. If it is not, tell me and stop.
2. Run `npm ci --ignore-scripts && npm run build`, then `npm run demo:placed` (no key, no network) and check it ends complete with 12 frames placed.
3. A live run needs a Daytona account, a Modal account and a Jev key. Ask me which I have: `DAYTONA_API_KEY` (app.daytona.io, Keys); a Modal token pair, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (modal.com, Settings, API Tokens); `TYPESAFE_API_KEY` (typesafe.ai), with `TYPESAFE_BASE_URL` only if I reach TypeSafe through a proxy of my own. Tell me where to create what I lack.
4. The Daytona sandbox needs node 22 or newer. If my organization's default sandbox has none, ask me for `DAYTONA_SNAPSHOT`, a snapshot that has it (app.daytona.io, Snapshots).
5. Run `npm install --no-save modal@0.11.0`. It adds the Modal SDK to `node_modules` only, not to any file the repository tracks.
6. Export the keys in my shell for this session only. Never write a key into a file in the repository, a commit or a log, and never print one.
7. A live run makes two sandboxes and asks Jev once a frame, and Daytona, Modal and TypeSafe may charge my accounts. Tell me that, and wait for my go before the next step.
8. Run `npm run demo:placed -- --live`. When it ends, check that `release` listed both sandboxes, and that the Daytona and Modal dashboards show no sandbox labelled `example=placed-frames`; if one is left, tell me its id and ask before ending it.
9. Nothing here needs sudo or a system change. If a step seems to, stop and ask me; never run one yourself.

When it finishes, show me the answer it printed, where each frame was placed, and the recording directory if I passed `--record`.
