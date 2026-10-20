# Lake Mead from Space, 40 Years

The question in [question.md](question.md), asked of thirteen Landsat images of the same frame over Lake Mead, from Hoover Dam to the Overton Arm, 1984 to 2024 ([inputs.json](inputs.json), committed in [images/](images/)), and given the lake's end-of-month elevation record beside them ([lake-mead-elevation.csv](lake-mead-elevation.csv)): when the water fell the most and where, with a box on each place that went dry then. The record says when and how much; the images say where. The one vision agent ([../vision-agent](../vision-agent/README.md)) answers it. The images are cropped, true-colour renders of USGS Landsat Collection 2 scenes (Landsat 5, 8 and 9), one frame and one stretch for all thirteen; inputs.json names each scene, the mirror it was read from, the crop and the stretch, and [ASSETS.md](../../ASSETS.md) names each image's scene and what was done to it.

```sh
npm run demo:vision -- examples/lake-mead                        # on fakes: $0, no key, no network (the images are committed)
npm run demo:vision -- examples/lake-mead --live --max-usd 2     # real models: about $1.50 and 25 minutes, measured once
```

## Programs, keys and cost

Every run, on fakes (scripted stand-ins for every model, $0) or live, needs `ffmpeg`, `ffprobe`, `pdftoppm` and `pdftotext` on your path (`brew install ffmpeg poppler`, or `sudo apt-get install ffmpeg poppler-utils`).

A `--live` run needs:

- `GEMINI_API_KEY` ([aistudio.google.com](https://aistudio.google.com)): the model that runs the agent and the model that looks.
- `TYPESAFE_API_KEY` ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)): Jev, TypeSafe's judge model, which answers yes-or-no, choice, count and box questions. Needed unless a gateway (an OpenAI-compatible endpoint that serves every model) that passes TypeSafe through is set (`VIDEO_MODEL_BASE_URL` with `VIDEO_MODEL_API_KEY`); with one, `VIDEO_MODEL_API_KEY` is Jev's key unless this is set.
- `FAL_KEY` ([fal.ai](https://fal.ai)): optional, and not used here: these are still images, with no speech.
- No download: its thirteen images (3.3 MB) are committed in [images/](images/), and so is the elevation record (17 KB).

One measured live run cost about $1.50 and took about 25 minutes; a run's cost and time vary. A run stops past $1 unless `--max-usd <n>` sets another cap, and this one went past it, so the command above passes `--max-usd 2`. A live run prints little until it ends.

The agent (gemini-3.8-flash, thinking at medium; thinking is shown when the model returns it) runs shell commands with your user's rights on your machine: run it in a container or a VM.

The run is also given [map-key.md](map-key.md): the named arms, basins, bays, washes and rivers inside the frame, as the National Park Service's map names them, with where each lies, in thirds.

The run is also given [lake-mead-elevation.csv](lake-mead-elevation.csv), one row for each month the table gives a value from 1935 to 2025 (year, month, elevation_ft). Source: Lake Mead at Hoover Dam, end-of-month elevation (feet), Bureau of Reclamation, Lower Colorado Region, https://www.usbr.gov/lc/region/g4000/hourly/mead-elv.html, retrieved 2026-10-19; a work of the U.S. federal government, public domain.
