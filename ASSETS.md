# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## NASA material in the video chapters example

[examples/video-chapters/clip](examples/video-chapters/clip/clip.json) holds 24 seconds of NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969), so the example's run on fakes needs no network. NASA material is generally not subject to copyright in the United States; it does not acquire this repository's license, and its use here implies no endorsement by NASA. `clip/clip.json` fixes the file by size and SHA-256 and says how it was cut; `clip/cut.sh` makes the cut from the checked film of [examples/video-chapters/sources.json](examples/video-chapters/sources.json).

| File | Source | What was cut |
| --- | --- | --- |
| `eagle-clip-360-384.webm` | https://images-assets.nasa.gov/video/KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928/KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928~mobile.mp4 | seconds 360 to 384, re-encoded as VP9 and Opus, its sound kept |
