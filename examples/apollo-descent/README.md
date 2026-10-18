# The Apollo 11 Descent

The question in [question.md](question.md), asked of NASA's own record of the landing ([inputs.json](inputs.json)): the typed air-to-ground transcript (626 scanned pages), twelve photographs of the mission and the mission's descent film. The agent finds the ten pages and the eight film windows that cover the descent itself, reads them and the photographs, and writes the landing minute by minute, each line citing its page, photograph or film moment. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code.

```sh
npm run demo:vision -- examples/apollo-descent --live
```

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
