# A Film, in Chapters

The question in [question.md](question.md), asked of NASA's 1969 Apollo 11 film ([inputs.json](inputs.json)): cut it into chapters, each with a title, its start and end, a line on what happens and a frame, citing the moments it rests on. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it; nothing here is code.

```sh
npm run demo:vision -- examples/video-chapters --live   # about $0.25 to $0.50 for the whole film
```
