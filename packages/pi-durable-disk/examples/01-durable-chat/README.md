# Example 01: a durable chat that survives its process

A chat answers scripted messages on a directory of this machine, with `localRun`. [`on-a-directory.mjs`](on-a-directory.mjs)
kills its first process (`SIGKILL`) after the third answer and lets a second open the same run and answer the rest. The chat
goes on from the last committed message, and nothing is answered twice. It needs Linux (or macOS for development) and the
root build, nothing else; the run goes under `./chat-run/`. It guards one machine only: the directory is the claim. The
package README's [Try it](../../README.md#try-it-no-disk-no-key) is [pick-up-a-run](../pick-up-a-run/), the same idea with
no kill.

## Run it

```sh
node examples/01-durable-chat/on-a-directory.mjs    # about five seconds
```

## The files

- `on-a-directory.mjs`: the quickstart, the chat in one process tree.
- `app.ts`: an app module for `pi-durable-disk run --dir PATH --app examples/01-durable-chat/app.ts`: pi-ai's faux provider,
  eight messages, and an `onOpen` that submits each with a `requestId`. The model's reply names its generation.

To use a real model, replace the faux provider with your provider (see the reference's [The app](../../docs/reference.md#the-app)).
