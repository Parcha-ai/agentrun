# Hear and Find

The question in [question.md](question.md), asked of NASA's 1969 Apollo 11 film ([inputs.json](inputs.json)): when the landing call "Tranquility Base here. The Eagle has landed." is made during the descent (it is said more than once in the film), and when and where the planted flag is first seen. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it with a transcript, a coarse-to-fine search and Jev's box; nothing here is code.

```sh
npm run demo:vision -- examples/hear-and-find --live    # about $0.40, nine tenths of it the transcript
```

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
