# A Government Film, in Chapters

The question in [question.md](question.md), asked of a Bureau of Reclamation film on the building of Boulder Dam ([inputs.json](inputs.json)): cut it into chapters, each with a title, its start and end, a line on what happens and a frame, citing the moments it rests on. The film has no chapter cards of its own. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code.

```sh
npm run demo:vision -- examples/boulder-chapters --live
```

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
