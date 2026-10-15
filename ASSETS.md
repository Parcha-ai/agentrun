# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## NASA material in the Apollo 11 example

[examples/apollo11/slice](examples/apollo11/slice/slice.json) holds a small slice of NASA's Apollo 11 material, so the example's default run needs no network. NASA material is generally not subject to copyright in the United States; it does not acquire this repository's license, and its use here implies no endorsement by NASA. `slice/slice.json` fixes each file by size and SHA-256 and says how it was cut; `slice/cut.sh` makes the cuts from the checked files of [examples/apollo11/sources.json](examples/apollo11/sources.json).

| File | Source | What was cut |
| --- | --- | --- |
| `transcript-tec-p317-319.pdf` | https://www.nasa.gov/wp-content/uploads/2026/01/as11-tec.pdf | pages 317 to 319, the page objects copied unchanged |
| `transcript-tec-typed-p317-319.html` | https://www.nasa.gov/wp-content/uploads/static/history//alsj/a11/a11transcript_tec.html | the entries typed 04 06 43 00 to 04 06 48 59, byte for byte |
| `film-descent-1206-1224.webm` | https://images-assets.nasa.gov/video/KSC-19690716-MH-NAS01-0001-Apollo_11_Historical_Footage_and_Broll-DVC_1560/KSC-19690716-MH-NAS01-0001-Apollo_11_Historical_Footage_and_Broll-DVC_1560~preview.mp4 | seconds 1206 to 1224, re-encoded as VP9, no audio |
| `photo-AS11-36-5355.jpg`, `photo-AS11-40-5863.jpg`, `photo-AS11-44-6581.jpg`, `photo-AS11-44-6665.jpg`, `photo-AS11-45-6704.jpg` | https://images-assets.nasa.gov/image/as11-36-5355/as11-36-5355~medium.jpg and the same path for each frame | none: NASA's files unchanged |
