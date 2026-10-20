# pick-up-a-run: a run is a directory

A run is a directory, and whichever process opens it carries on where the last one released it. Three processes, one after
another, open the same run, answer one question of the same chat and release it. The last one still knows the first
question: the chat was in the directory, not in a process. At the end the run's record is read from outside, with no
process running.

It shows what the package is for, and it is the first example to run: no disk, no key, no network. The model is pi-ai's faux
provider.

## Run it

This is the README's [Try it](../../README.md#try-it-no-disk-no-key), as one file. It needs `@parcha/pi-durable-disk`
0.1.0-beta.15 or later (`localRun` first shipped in 0.1.0-beta.13, and `readLocalRunStatus`, which reads the run's
`run.json`, in 0.1.0-beta.15), on Linux with Node 22.19 or later.

**From an install** (an empty directory; the npm package does not ship `examples/`, so save the file from GitHub at the tag
of the version you installed):

```sh
npm install @parcha/pi-durable-disk@beta @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
# save main.ts from this directory as pick-up.mts (.mts: an ES module, whatever your package.json says), then
node pick-up.mts
```

**From a checkout:**

```sh
npm ci --ignore-scripts && npm run build   # once, from the repository root; builds dist/
cd packages/pi-durable-disk
node examples/pick-up-a-run/main.ts        # about two seconds
```

It writes `pick-up-a-run-run/` under the current directory and prints:

```
the run is <this directory>/pick-up-a-run-run
generation 1 opened the run (0 answered before)
  Where does your transcript live?
  Answer 1, by generation 1. You first asked: "Where does your transcript live?"
generation 2 opened the run (1 answered before)
  Who had this run before you?
  Answer 2, by generation 2. You first asked: "Where does your transcript live?"
generation 3 opened the run (2 answered before)
  Do you remember my first question?
  Answer 3, by generation 3. You first asked: "Where does your transcript live?"
ok: three processes, one run: each picked up where the last released it, the last still knew the first question, and the run reads done at generation 3 (<this directory>/pick-up-a-run-run)
```

## How it works

- The file is its own supervisor: `main.ts` starts `main.ts instance` three times, one after another, reads each one's lines
  and waits for `close`, not `exit`. Nothing is shared between the processes but the directory.
- An instance is `openDurableRun` on `localRun(root)`. Each opens the next generation (`run.generation`), reads how many
  answers the store already holds, submits the next question with a request id (`question-<n>`, so a message is a no-op
  once it was admitted), prints the answer, and sets the run `paused` (or `done` after the last question) and releases it.
  `release()` seals the run, and the next open finds the store as the last process left it.
- The faux model answers from the conversation it is handed, which is why the third answer can quote the first question:
  pi-durable gave it the messages the first two processes committed.
- `readLocalRunStatus(root)` reads the run's `run.json` from outside: `done`, generation 3.

## What it does not show

A run on a local directory guards one machine only: the directory is the claim, so nothing keeps out a process on another
machine that can reach it. [Bring your own disk](../../README.md#bring-your-own-disk) puts the run on an Archil disk that any
host can mount, and [planned-move](../planned-move/) moves a run between two hosts. The model is scripted, so the answers say
nothing about a real model.
