# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## Test media

`packages/pi-vision/test/binaries/assets/apollo11-landing.webm` is 20 seconds of the soundtrack of NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969, public domain as a work of the United States government), from second 795 of the film's mobile rendition on images.nasa.gov (nasa_id `KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928`, sha256 `c3ccbdfc11398b9e7c714722939aaac04ba008919721faa7a0ad421631df7dc8`), cut with `ffmpeg -ss 795 -t 20 -i <film> -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact` (ffmpeg 6.1.1; sha256 `d6f618a18978a1a2b0ea40e0e318bc54bbcbfa88caab78590acc5b5ca8126002`). NASA's media guidelines ask that NASA not be implied to endorse anything; it does not here.

## Hear and find

[examples/hear-and-find/clip](examples/hear-and-find/clip/clip.json) holds 34 seconds of NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969), so the example's run on fakes needs no network: three pieces of the film, one after the other. NASA material is generally not subject to copyright in the United States; it does not acquire this repository's license, and its use here implies no endorsement by NASA. `clip/clip.json` fixes the file by size and SHA-256 and says where each piece is in the film; `clip/cut.sh` makes the cut from the checked film of [examples/hear-and-find/sources.json](examples/hear-and-find/sources.json).

| File | Source | What was cut |
| --- | --- | --- |
| `eagle-heard-and-seen.webm` (sha256 `2c24b66826c855db3cd6e2f0fc5f4e29d82b0b0a46adead27210a1cefdf05f45`) | https://images-assets.nasa.gov/video/KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928/KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928~mobile.mp4 | seconds 118 to 128, 798 to 808 and 1016 to 1030, joined and re-encoded as VP9 and Opus, their sound kept |
