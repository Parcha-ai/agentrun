# Placed Frames

A pi agent's tool calls go to Daytona and Modal sandboxes, and Jev places each one on the sandbox that fits it.

The agent is asked to draw a zoom into the Mandelbrot set, twelve frames. It has two tools: `frame`, one call for each frame, and `release`. It never sees where a call may go. Before each `frame` call runs, Jev reads the frame as numbers (how much closer than the first frame, how many iterations per pixel) and each sandbox's one-line purpose, and the call runs in the sandbox it picks: wide views in a small Daytona sandbox, deep views in a Modal sandbox with two CPUs. Each answer tells the agent which sandbox the frame ran in, that sandbox by its label (`box-1`, `box-2`), and one line on why, built from Jev's score. The agent releases the sandboxes and says how the frames were spread. The result is one picture of all the frames, with a card whose rows cite the tool calls they count.

```sh
npm ci --ignore-scripts && npm run build
npm run demo:placed                  # no key, no network: both sandboxes are folders on this machine
npm run demo:placed -- --live        # real Daytona and Modal sandboxes, and Jev, with your own accounts
```

## Without a key

Both environments are local boxes, directories of this machine. A scripted lead stands in for the model (it asks for every frame in one turn, releases, and says what the answers say), and a script stands in for Jev: it sends a frame at 150 iterations per pixel or more to `modal` and the rest to `daytona`. Everything else is the live path (the same tools, the same placer asking through pi-ai's provider boundary), and every answer, the recording's manifest and the line on each frame say the script judged, not Jev. The run finishes with 12 frames, 7 on `daytona`'s box and 5 on `modal`'s.

| Flag | What it does |
|---|---|
| `--live` | real Daytona and Modal sandboxes, and Jev (below) |
| `--record <dir>` | keep the run as an `agentrun.recording/1` directory |
| `--input '{"frames":6}'` | another number of frames, 2 to 24 |
| `--dir <path>` | keep the run's directory, to look at the frames it kept under `work/frames/` |

## Live

A live run needs a model for the agent (Google's gemini-3.8-flash, thinking at medium, shown when the model returns it), your own Daytona and Modal accounts, and a Jev key:

| Name | For |
|---|---|
| `GEMINI_API_KEY` (or a gateway's `VIDEO_MODEL_BASE_URL` and `VIDEO_MODEL_API_KEY`) | the agent; a gateway serves it under its public id and passes Jev through at `/typesafe/v1` |
| `DAYTONA_API_KEY` | the `daytona` environment: Daytona sandboxes, made through Daytona's REST API |
| `DAYTONA_SNAPSHOT` (optional) | a snapshot with node 22 or newer, when your organization's default sandbox has none |
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | the `modal` environment: Modal sandboxes, through the Modal SDK |
| `TYPESAFE_API_KEY` | Jev at TypeSafe, which places each frame |
| `TYPESAFE_BASE_URL` (optional) | another address for TypeSafe's API, when you reach it through a proxy of your own |

The Modal SDK is not installed with this repository: `npm install --no-save modal@0.11.0`. Each key stays in the demo's process; none reaches a sandbox, and none is one the agent's tools could read. The sandboxes carry the label `example=placed-frames`, end when the run releases them, and end by themselves after 20 minutes at most, so a run that dies leaves nothing for long. `SETUP-PROMPT.md` sets a live run up for you.

## What it is not

Jev picks one of the places the config names; it does not make a place. The sandboxes are the ones in `demo.json` (`placement`): their purposes are what Jev reads, so another zoom or another job needs its own lines. The line on each frame is the example's own, and what the card says is read from the calls the tools answered, never from what the agent wrote. The line is composed from the placement record's fields (where, who judged, the score); it is what was judged, not a proof the other sandbox could not have done it.

## Runtime dependencies

`@parcha/agentrun-reference` (the host: `demo()`), `@parcha/pi-transport` (the boxes, `jevPlacer`, `boxEnv`), `@earendil-works/pi-durable` (the agent's tools), `@earendil-works/pi-ai` (the lead's models, and Jev's and the script's classifier) and `@parcha/agentrun-dsl` (the workflow's types).
