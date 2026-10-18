# A Robot in a Long Film

The question in [question.md](question.md), asked of a 1939 Technicolor drama filmed at the New York World's Fair ([inputs.json](inputs.json)): when a golden robot is first seen, and where it is in the frame. The robot is on screen for a few minutes of a film of nearly an hour, and small in its first shot. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code.

```sh
npm run demo:vision -- examples/fair-robot --live
```

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
