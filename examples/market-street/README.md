# Every Vehicle on Market Street

The question in [question.md](question.md), asked of a 1906 film shot from the front of a moving cable car down San Francisco's Market Street, four days before the earthquake ([inputs.json](inputs.json)): log every vehicle that crosses in front of the camera, with the second it passes, what it is and a box around it in that frame, then count each kind. The film runs nearly ten minutes and the street never empties: cable cars, automobiles, horse carriages and wagons, bicycles. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code.

```sh
npm run demo:vision -- examples/market-street --live
```

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.
