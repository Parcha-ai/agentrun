---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
A sandbox can list the programs its agent needs on the box's PATH, `computer.needs` (such as `["chrome", "ffmpeg", "ffprobe", "hyperframes"]`), and the computer package ships a media image that has them. Each run's claim asks the box it started before the run's first model request; a box that lacks one, or that cannot be asked, is let go and the run ends `failed` (`run_failed`) in words naming what is missing and how to give the box an image that has it. The field never picks an image: a Docker box's image is still `AGENTRUN_DOCKER_IMAGE`'s. An agent without `needs` is checked for nothing.
The media image's recipe is `packages/computer/media/Dockerfile`: the default image's base and programs, plus Node 24, Chromium as `chrome`, FFmpeg and FFprobe, Noto (CJK, colour emoji) and Liberation fonts, and the HyperFrames CLI at an exact version, with its usage reports off. Build it and name its tag in `AGENTRUN_DOCKER_IMAGE`; the serve README's "The box's image" has the commands. It is not published.
