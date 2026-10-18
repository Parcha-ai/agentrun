---
packages: repo
kind: feature
---
`examples/vision-agent` (`npm run demo:vision -- examples/<folder>`): one vision agent for any question about a set of files, on the reference host. It is given the question in plain words and the files, plans its own steps, writes code with `vision.see`, `vision.judge` and `vision.transcribe` following pi-vision's skills as the package ships them, runs gemini-3.8-flash thinking at medium, and ends with an HTML report that cites every claim at the file's own page, second or region; the recording keeps the report and its pictures and clips. Three examples are questions and files, with no code: `examples/video-chapters` and `examples/hear-and-find` (NASA's 1969 Apollo 11 film, fetched and checked) and `examples/document-check` (a Delaware certified copy filed with the SEC and an altered test copy, committed with their source in ASSETS.md).
