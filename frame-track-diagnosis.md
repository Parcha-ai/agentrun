# Frame-track encoding diagnosis

**A pre-existing FFmpeg 7 compatibility defect in the synced frame-track exporter, not a console regression.** The existing focused case passes with FFmpeg 6.1.1 and fails with FFmpeg 7.1.5. With identical JPEG bytes and the same compiled exporter, FFmpeg 7 produces **50 frames / 5.000 seconds**, while the index correctly describes **40 frames / 4.000 seconds**. The failure is actual video/index duration drift, not only a different frame-count report.

This investigation changed no repository source or test; its writes were confined to synthetic diagnostic evidence. The synced package must be corrected in its owning source repository and imported through its normal sync process.

## Witnesses

| Environment | Versions | Existing focused case | Same-input exporter output |
|---|---|---|---|
| Host | Ubuntu 24.04.4 LTS; Node 22.23.1; FFmpeg/ffprobe `6.1.1-3ubuntu5+esm15`; libvpx9 `1.14.0-1ubuntu2.3` | PASS, 1/1 | VP9 WebM, 800×500, 10 fps, 40 decoded frames, 4.000 seconds |
| Full-check image | Debian 13 trixie; Node 22.23.2; FFmpeg/ffprobe `7.1.5-0+deb13u1`; libvpx9 `1.15.0-2.1+deb13u1` | FAIL, expected 40 / actual 50 | VP9 WebM, 800×500, 10 fps, 50 decoded frames, 5.000 seconds |

The test is `packages/pi-browser/test/frame_track.test.mjs:85`; its frame-count assertion is at line 104. Its next assertion also requires a duration near four seconds. The full-gate failure appears at the same assertion, and an isolated rerun in that image reproduces it.

The test image is `gre4118-check-tools:node22`, immutable image ID `sha256:6ad01f2cc3009a227831792982e055053428f739a4c6e9b1ce7ffd337249f4d8`. The controlled reproduction used that same image without network access, a read-only checkout and a writable synthetic-evidence directory.

[Host focused TAP](gre4118-frame-track-evidence/focused-host.tap), [image focused TAP](gre4118-frame-track-evidence/focused-container.tap), [host versions/hashes](gre4118-frame-track-evidence/host-environment.json), [image versions/hashes](gre4118-frame-track-evidence/image-environment.json), [host actual output](gre4118-frame-track-evidence/host/result.json), [image actual output](gre4118-frame-track-evidence/image/result.json).

## Why it happens

`packages/pi-browser/src/recorder/track.ts:249` writes each still image with its planned duration. Line 250 repeats the final file so FFmpeg versions that ignore a final duration still retain the last segment. Lines 252–254 encode the concat input with `fps=10,format=yuv420p` and `-fps_mode cfr`, without an explicit final output duration.

A direct FFmpeg reproduction isolates that last-file convention from Node and the exporter. Both environments read the same four one-second image segments; the only variant is whether the final file is repeated:

| Identical input list / encoder options | FFmpeg 6.1.1 | FFmpeg 7.1.5 |
|---|---|---|
| Four durations, final file repeated (current exporter convention) | 40 frames / 4.000 s | 50 frames / 5.000 s |
| Four durations, no repeated final file | 30 frames / 3.000 s | 40 frames / 4.000 s |

The same **40/50 versus 30/40** counts occur when output is raw `framemd5` instead of VP9. That excludes libvpx encoding and ffprobe's WebM frame-count reporting as the cause. The observed difference is FFmpeg's end-of-input handling for the concat still-image sequence and its repeated final file. This investigation does not identify the particular upstream FFmpeg change responsible.

[Direct host results](gre4118-frame-track-evidence/direct/host.json), [direct image results](gre4118-frame-track-evidence/direct/image.json), [raw host counts](gre4118-frame-track-evidence/direct/host-raw-counts.json), [raw image counts](gre4118-frame-track-evidence/direct/image-raw-counts.json), [same-input exporter script](gre4118-frame-track-evidence/reproduce.mjs), [direct FFmpeg script](gre4118-frame-track-evidence/direct.mjs), [raw-output script](gre4118-frame-track-evidence/raw-counts.mjs).

## Baseline identity

The following Git blobs are identical in baseline `95cdc5b9`, upstream main `bc18a59f`, and candidate `d9ff826df3195a2fb94530ad95d39186168341c8`:

- Exporter source: `271c3ace587948a04b68538304597131d8a3f938`.
- Existing test: `e24de3829394134083d33abebfefd36b85fcfcee`.

The loaded compiled exporter SHA-256 is identical on host and image: `35eacb13b3411fb8de5040296c54ef2f46a996088d13689e918fa9b530af4e4f`. The controlled exporter runs also use the same three input JPEG SHA-256 values, recorded in both result files. No image was regenerated in the second environment.

[Git blob identities](gre4118-frame-track-evidence/source-identities.json). Baseline equivalence was verified through source/test blob identity; a complete baseline checkout was not rebuilt or run.

## Reproduction and limits

From a public checkout with its existing build and dependencies:

```sh
ffmpeg -version
ffprobe -version
node --test --test-name-pattern="a session's frames become a WebM" \
  packages/pi-browser/test/frame_track.test.mjs
```

The linked diagnostic scripts take a checkout/evidence directory or evidence directory as arguments, as shown by their argument declarations. `reproduce.mjs` invokes the existing public `exportFrameTracks` implementation; `direct.mjs` and `raw-counts.mjs` invoke FFmpeg directly. The evidence directory contains the exact synthetic JPEGs and input lists used, so the same bytes can be reused in another runtime. All diagnostic containers used `--rm --init --network none`; successful absence readback is recorded in [exporter cleanup](gre4118-frame-track-evidence/cleanup.json), [direct cleanup](gre4118-frame-track-evidence/direct-cleanup.json), [raw cleanup](gre4118-frame-track-evidence/raw-cleanup.json), and [environment cleanup](gre4118-frame-track-evidence/environment-cleanup.json).

This establishes the defect for these two concrete FFmpeg environments. It does not qualify every FFmpeg 6 or 7 release, identify an upstream fixing commit, or remediate the exporter. The observed FFmpeg 7 full-gate run failed this case; that run must not be reported green. The independent 31-checkpoint console/browser proof remains valid: those paths play existing file bytes and do not invoke frame-track export.
