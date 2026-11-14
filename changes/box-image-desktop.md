---
packages: @parcha/agentrun-computer
kind: feature
---
The box image carries its desktop: `box/Dockerfile` installs Xvfb, xfwm4 and the apps (Xfce's terminal, Mousepad, Firefox ESR, xdotool), with nothing started, so one image, one tag and one recipe hash serve an Archil sandbox and a desktop, the published `ghcr.io/parcha-ai/agentrun-box:<recipe hash>` and the public E2B template among them. `box/build-agent37.mjs` builds that same recipe and names it by `box/recipe.mjs`'s hash; its `DESKTOP` and `DESKTOP_PACKAGES` exports are gone.
