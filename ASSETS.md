# Documentation assets

The support workflow illustration and its editable source live in [docs/assets](docs/assets/README.md). The original diagram and animation use the repository's Apache-2.0 license. The bundled font has separate terms in [FONT-LICENSE.txt](docs/assets/readme-animation/assets/FONT-LICENSE.txt).

The website is maintained in a separate private repository. Its artwork is outside this source release and does not acquire a license from this repository.

## Test media

`packages/pi-vision/test/binaries/assets/apollo11-landing.webm` is 20 seconds of the soundtrack of NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969, public domain as a work of the United States government), from second 795 of the film's mobile rendition on images.nasa.gov (nasa_id `KSC-19690716-MH-NAS01-0001-The_Flight_of_Apollo_11_The_Eagle_Has_Landed_HS_from_Film_JSC-DVC_1928`, sha256 `c3ccbdfc11398b9e7c714722939aaac04ba008919721faa7a0ad421631df7dc8`), cut with `ffmpeg -ss 795 -t 20 -i <film> -vn -ac 1 -ar 16000 -c:a libopus -b:a 24k -map_metadata -1 -fflags +bitexact` (ffmpeg 6.1.1; sha256 `d6f618a18978a1a2b0ea40e0e318bc54bbcbfa88caab78590acc5b5ca8126002`). NASA's media guidelines ask that NASA not be implied to endorse anything; it does not here.

## SEC EDGAR exhibit in the document check example

[examples/document-check/sample](examples/document-check/sample/sample.json) holds pages 1 to 4 of exhibit 3.1 to the annual report on Form 10-K of AVEO Pharmaceuticals, Inc. (CIK 0001325879) for the period ended 2021-12-31, filed with the SEC on 2022-03-14, accession number 0001628280-22-006093: a Delaware certified copy of the company's restated certificate of incorporation, with the Delaware Secretary of State's certification pages. It is a public filing, retrieved from SEC EDGAR on 2026-10-18 and included for testing and illustration as fair use. It does not acquire this repository's license, and its use here implies no endorsement by the SEC, the State of Delaware or the company. Filing index: https://www.sec.gov/Archives/edgar/data/1325879/000162828022006093/0001628280-22-006093-index.html. Exhibit: https://www.sec.gov/Archives/edgar/data/1325879/000162828022006093/aveo20211231ex31.htm.

| File | Source | SHA-256 | What was changed |
| --- | --- | --- | --- |
| `aveo-ex3-1-pages-1-4.pdf` | the exhibit's page images `aveo20211231ex31001.jpg` to `aveo20211231ex31004.jpg` (each URL and SHA-256 in `sample.json`) | `cd4990d97f267a0f8849a39f6f224af078236134126c76d0a5fb9672e606e808` | nothing: each page image is placed on a Letter page byte for byte |
| `aveo-ex3-1-pages-1-4-TEST-COPY-marks-removed.pdf` | the same four page images | `0f39e3f0011932320ac920f929be5f33cbc1641d5950d584f46d605255308cbe` | altered for testing: on pages 1 and 2 the seal, the signature, the file and SR numbers and the authentication number and date are painted white; on page 3 the FILED stamp is painted white; every page carries the footer "TEST COPY: marks removed by agentrun for testing; not the filed document". It is not the filed document. |

`sample/build.mjs` makes both files from the page images, which it checks by SHA-256. It fetches them from EDGAR with a User-Agent naming the project, or reads them from a folder.

## The vision examples' NASA film

[examples/video-chapters](examples/video-chapters/inputs.json) and [examples/hear-and-find](examples/hear-and-find/inputs.json) read NASA's film "The Flight of Apollo 11: The Eagle Has Landed" (1969) by URL; nothing of it is committed. A live run fetches the mobile rendition from images.nasa.gov and checks it by size and SHA-256 (`c3ccbdfc11398b9e7c714722939aaac04ba008919721faa7a0ad421631df7dc8`). NASA material is generally not subject to copyright in the United States; it does not acquire this repository's license, and its use here implies no endorsement by NASA.

## The other vision examples' films, transcript and photographs

None of these files is committed: a live run fetches each by URL and checks it by size and SHA-256 (the values are in each folder's `inputs.json`).

- [examples/apollo-descent](examples/apollo-descent/inputs.json) reads NASA's Apollo 11 air-to-ground transcript (https://www.nasa.gov/history/mission-transcripts-mercury-gemini-and-apollo/, SHA-256 `d519ee18dfa0c318f39d36a6b6c492f1de286134988e23b594d63f3a18703870`), NASA's descent film (https://images-api.nasa.gov/search?nasa_id=KSC-19690716-MH-NAS01-0001-Apollo_11_Historical_Footage_and_Broll-DVC_1560, SHA-256 `72fb13f25ffddddcc197b40b0bc67127e14cdf4055322a56af3c4ee538c24d15`) and twelve Apollo 11 photographs from images.nasa.gov. NASA material is generally not subject to copyright in the United States; it does not acquire this repository's license, and its use here implies no endorsement by NASA.
- [examples/boulder-chapters](examples/boulder-chapters/inputs.json) reads "Boulder Dam" (United States Department of the Interior, Bureau of Reclamation, 1930s) from the Prelinger Archives at the Internet Archive, https://archive.org/details/tmp_BoulderD_2 (SHA-256 `72d8a4b3ad902f237df77dcbac441e3fab0ddabeb59d3ab0dbf9676062e4899b`). The source page marks it public domain. The film credits no score, and an uncredited score cannot be ruled out; the project uses the film as the source page publishes it, relying on that statement.
- [examples/fair-robot](examples/fair-robot/inputs.json) reads "The Middleton Family at the New York World's Fair" (Audio Productions Inc. for Westinghouse, 1939) from the Prelinger Archives at the Internet Archive, https://archive.org/details/middleton_family_worlds_fair_1939 (SHA-256 `b92706bb51004fe1527bd242ecf6c227b93c53226d9ad6b5890f464eb98eb4cc`). The source page states "Public Domain." It is a corporate film, not a government work, with its own soundtrack; the project uses the film as the source page publishes it, relying on that statement.
- [examples/market-street](examples/market-street/inputs.json) reads "A trip down Market Street before the fire" (Miles Brothers, filmed 14 April 1906) from the Library of Congress, https://www.loc.gov/item/00694408/, as the viewing copy at https://tile.loc.gov/storage-services/service/mbrs/ntscrm/00015143/00015143.mp4 (SHA-256 `13938707da4cf835a7f6215980b013a8370a13ec6447d292e0f4c498fe938c58`). The source page states: "The contents of the Library of Congress Before and After the Great Earthquake and Fire: Early Films of San Francisco, 1897 to 1916 Collection are in the public domain and are free to use and reuse." It is a silent film (the file carries one audio track of digital silence); the project uses the film as the source page publishes it, relying on that statement.

## Vendored code

The run viewer ships PDF.js, `pdfjs-dist` 6.4.299 (Mozilla Foundation, Apache-2.0), with its JavaScript decoders for a
scan's images (PDFium's for CCITT and JBIG2, BSD-3-Clause; OpenJPEG's for JPEG 2000, BSD-2-Clause), as the package's
release files, unchanged, from https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz. They are in
[apps/viewer/vendor/pdfjs](apps/viewer/vendor/pdfjs/README.md) with their license files; `vendored.json` there lists
each file's size and SHA-256 (2,348,024 bytes in all), a test checks every file against it, and `docs/dependencies.md`
lists it under "Vendored code".

## Landsat images in the Lake Mead example

[examples/lake-mead/images](examples/lake-mead/inputs.json) holds thirteen views of one frame over Lake Mead (WRS-2 path 39, row 35; Hoover Dam to the Overton Arm), made from USGS Landsat Collection 2 Level-2 surface reflectance scenes, read from the Microsoft Planetary Computer's copy of that collection. Each was cropped and resampled to the same frame (WGS 84 / UTM zone 11N, 60 m pixels, 927 x 1132), rendered in true colour from the red, green and blue bands with one fixed stretch for every image (reflectance 0 to 0.30, gamma 1/1.8), and saved as JPEG. Nothing else was changed. The USGS says of Landsat data (https://www.usgs.gov/faqs/are-there-any-restrictions-use-or-redistribution-landsat-data): "There are no restrictions on Landsat data downloaded from the USGS; it can be used or redistributed as desired. We do request that you include a statement of the data source when citing, copying, or reprinting USGS Landsat data or images." Landsat imagery courtesy of the U.S. Geological Survey. USGS Landsat Collection 2 is public domain as the USGS states it. The mirror that served the scenes is the Microsoft Planetary Computer (collection `landsat-c2-l2`, each scene's record named in inputs.json): its record for this collection gives the licence as "Public Domain", linking the USGS data policy (https://www.usgs.gov/core-science-systems/hdds/data-policy), and names the USGS and NASA as producers and licensors and Microsoft as host. Its own terms ("Supplemental Terms of Use for Microsoft Planetary Computer Previews", last updated January 2023, https://planetarycomputer.microsoft.com/terms) cover the use of the service and its access tokens: "Previews are made available to you on the condition that you agree to these Supplemental Terms of Use"; they set no terms on the Landsat data itself. Its use here implies no endorsement by the USGS, NASA or Microsoft.

| File | Source scene | SHA-256 |
| --- | --- | --- |
| `lake-mead-1984-05-15.jpg` | Landsat 5 TM scene LT05_L2SP_039035_19840515_02_T1 (LT50390351984136PAC00), acquired 1984-05-15 | `125f03b2cdf5c01c24267861903471787d420caa9c42c61050ec8e0440a0f252` |
| `lake-mead-1987-08-12.jpg` | Landsat 5 TM scene LT05_L2SP_039035_19870812_02_T1 (LT50390351987224XXX02), acquired 1987-08-12 | `7aa1659be6e9b89a5c49416d8c93389ef5a9e7c682c861f57374a9d5c2fa5fa6` |
| `lake-mead-1990-07-03.jpg` | Landsat 5 TM scene LT05_L2SP_039035_19900703_02_T1 (LT50390351990184XXX03), acquired 1990-07-03 | `b218a2eec96c1d258af382b38c0154db0979d533d1a3718b265f035e78a92cc1` |
| `lake-mead-1993-07-11.jpg` | Landsat 5 TM scene LT05_L2SP_039035_19930711_02_T1 (LT50390351993192AAA02), acquired 1993-07-11 | `dcf209b46d97ba25e91ff268504beb5965fdf1acbf89488d56d347df4f41faca` |
| `lake-mead-1997-07-06.jpg` | Landsat 5 TM scene LT05_L2SP_039035_19970706_02_T1 (LT50390351997187AAA01), acquired 1997-07-06 | `ffcde9b1f983c42e31b6fc0b00fbec78392871a82ae36f182990928dd9589308` |
| `lake-mead-2000-05-27.jpg` | Landsat 5 TM scene LT05_L2SP_039035_20000527_02_T1 (LT50390352000148XXX01), acquired 2000-05-27 | `cacaf34d2f0ad3cbbe08c0c826fce82a54051a58b1e8f3a21c5df6035bcb0bc6` |
| `lake-mead-2003-07-07.jpg` | Landsat 5 TM scene LT05_L2SP_039035_20030707_02_T1 (LT50390352003188PAC02), acquired 2003-07-07 | `99899f9edc9e4ab480ba02934c8155ef333638bed9b6db282b3bcba422c9c8b1` |
| `lake-mead-2006-07-15.jpg` | Landsat 5 TM scene LT05_L2SP_039035_20060715_02_T1 (LT50390352006196PAC01), acquired 2006-07-15 | `2afbb9b45053ec219d3300465c5cef91764215dac66bc9c34701d571667c9394` |
| `lake-mead-2010-06-24.jpg` | Landsat 5 TM scene LT05_L2SP_039035_20100624_02_T1 (LT50390352010175EDC00), acquired 2010-06-24 | `416a3c5fbacd163877a2f06bcd5acce42403d366edac37d889d0fa3327465784` |
| `lake-mead-2014-07-21.jpg` | Landsat 8 OLI scene LC08_L2SP_039035_20140721_02_T1 (LC80390352014202LGN01), acquired 2014-07-21 | `ed5babc75ce8951a181129701b0bfd66bdba0b0dad794838d4d85d465d466cdc` |
| `lake-mead-2018-06-30.jpg` | Landsat 8 OLI scene LC08_L2SP_039035_20180630_02_T1 (LC80390352018181LGN00), acquired 2018-06-30 | `e85df171b994df28cfea8ce8315a897ea58c0e01bec756201a07ba49e6c04571` |
| `lake-mead-2022-07-03.jpg` | Landsat 9 OLI-2 scene LC09_L2SP_039035_20220703_02_T1 (LC90390352022184LGN00), acquired 2022-07-03 | `a9d4b50b01824fb6caed83fd3c251fe482eeebff4177a580b3c53a0f59cbba34` |
| `lake-mead-2024-07-08.jpg` | Landsat 9 OLI-2 scene LC09_L2SP_039035_20240708_02_T1 (LC90390352024190LGN00), acquired 2024-07-08 | `04e9bb38db8ec90c4bde9db19f116a04b50899ab790393054db8b33c9026c8aa` |

`map-key.md` (SHA-256 `320dda97c7dccc19ec3f5dc67b4b2943583876a8d1f975f56b411274ae03bb9e`) lists the named arms, basins, bays, washes and rivers inside the frame with where each lies, in thirds, taken by name only from the National Park Service's "Park Map - Lake Mead National Recreation Area" (https://www.nps.gov/npgallery/GetAsset/b74cc29c-79a5-4ab4-ac69-54982c8a4a3a), which its gallery page states is in the public domain; no image of the map is copied.

`lake-mead-elevation.json` (SHA-256 `59ad60580e5db4c1736bf8877e54c657b231394e7eea34f7cf4616d1f1c543dd`) holds Lake Mead at Hoover Dam's end-of-month elevation in feet, one row ([year, month, elevation_ft], under "rows") for each month from 1935 to 2025 that the Bureau of Reclamation's Lower Colorado Region table gives a value for (https://www.usbr.gov/lc/region/g4000/hourly/mead-elv.html, retrieved 2026-10-19), each value as the table prints it. It is a work of the U.S. federal government and so in the public domain.
