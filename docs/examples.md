# Runnable examples

Start with the [support quickstart](../README.md#quickstart). Every example below runs on scripted models by default, with no key: it exercises the workflow and its plumbing, not model quality. The workflow examples use fictional inputs; the vision examples use real public files (public-domain films and photographs, and pages of a public filing).

After `npm ci --ignore-scripts` and `npm run build`:

| Example | Run | What to change |
| --- | --- | --- |
| [Support answers](support-quickstart.md) | `npm run demo:support` | Connect your search tool and agent; check an answer before returning it. |
| [Typed research](authoring.md) | `npm run demo` | Reuse one research component across questions and stop when evidence is missing. |
| [Rank a list](../examples/rank-candidates.mjs) | `npm run demo:rank` | Score candidates against your brief, drop duplicates, cap each bucket, keep the top k; call it from another workflow. |
| [Standalone TypeScript app](../examples/starter/README.md) | Follow the app's install steps, then `npm test` and `npm start` | Build outside this checkout with public package imports. |
| [The reference host](reference-host.md) | `npm run demo:reference` | One durable pi run with the recovery driver, a browser and vision: replace the scripted model, tools, browser and eyes with yours. |
| [The hero job](../examples/hero/README.md) | `npm run demo:hero` | One agent reads nine grid operators' dashboard charts with vision, each in a browser session of its own, and, where the operator also publishes the mix as data, checks each reading against it. |
| [The vision agent](../examples/vision-agent/README.md) | `npm run demo:vision -- examples/document-check` (free; needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext`), and add `--live` with your keys | Ask a question about your own files: write a folder with the question and the files' addresses; one agent answers it and ends with its own report. |

The ranking example is a reusable workflow built from existing nodes, not a node of its own. A `sift` scores every candidate with a leveled question, and the continuous score in `<as>.answers[i].answers.<question>.score` orders them. Sorting, the minimum score, per-bucket quotas and the cut-off are a `code` step. A second `sift` over pairs finds near-duplicates among the best `consider` candidates, the only ones that can make the list. That costs `consider × (consider − 1) / 2` questions, so the caller chooses it. A long list needs no batching in the workflow: a `sift` over the host's per-request limits splits itself. `npm run demo:rank -- --live --input request.json` ranks your own list with Jev.

Each example includes a failure or uncertainty path. `npm run demo:support -- unresolved` and `npm run demo -- --no-evidence` exit with code `2` after escalation.

To connect models, follow [support integration](support-quickstart.md) or [research integration](live-research.md). Your application supplies tool permissions, credentials and cancellation. Scripted answers remain fixed when you edit a prompt.

## Vision examples

[`@parcha/pi-vision`](../packages/pi-vision/README.md) reads files for a model. One agent, [`examples/vision-agent`](../examples/vision-agent/README.md), answers every question below; each folder holds only the question, the files' addresses and checks, and a README. All but the document check fetch their files first: add `--fetch-sources` (the size is in each one's README).

- **[Video chapters](../examples/video-chapters/README.md).** A long film cut into chapters, each with a keyframe and the minutes it rests on.
- **[Hear and find](../examples/hear-and-find/README.md).** When a phrase is said and when a thing is first seen in a long film: both seconds, the frame and a box around the thing.
- **[Document check](../examples/document-check/README.md).** Two certified copies of a certificate of incorporation: which marks each carries and where, with a box on each.
- **[The Apollo 11 descent](../examples/apollo-descent/README.md).** NASA's transcript, photographs and film, read into the landing minute by minute.
- **[A government film, in chapters](../examples/boulder-chapters/README.md).** A 1930s film on the building of Boulder Dam, cut into chapters.
- **[A robot in a long film](../examples/fair-robot/README.md).** When a golden robot is first seen in a 1939 film of nearly an hour, and where it is in the frame.
- **[Lake Mead from space](../examples/lake-mead/README.md).** Thirteen Landsat images of one frame, 1984 to 2024: when the water fell most, and every shoreline it left, boxed and dated.
- **[A trip down Market Street, 1906](../examples/market-street/README.md).** A single take from a cable car: every vehicle that crosses in front of the camera, to the second, boxed, then counted by kind.
