---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
A sandbox can list the programs its agent needs as `computer.needs`, and a template can list them as `needs` beside `computer: [shell]`. Each run checks the box on the agent's shell PATH before its first model request. A box that lacks one ends the run `failed`, in words naming what is missing and `AGENTRUN_DOCKER_IMAGE`. `needs` never picks an image. Where the shell is not a sandbox, applying such a template is refused (`409`). A server before this release refuses a template that names `needs`.
`packages/computer/media/Dockerfile` builds a media image that has them: Chromium as `chrome`, FFmpeg, FFprobe, fonts and the HyperFrames CLI. It is not published. Build it and name its tag in `AGENTRUN_DOCKER_IMAGE`; the serve README's "The box's image" has the commands.
