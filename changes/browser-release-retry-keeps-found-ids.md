---
packages: @parcha/pi-browser
kind: fix
---
A browser session found by its tag (its create's answer was lost) is billed at its release even when the release is tried again. Before, a release that stopped the session but could not confirm it started its next attempt without the ids it had found, and a provider's tag lookup lists running sessions only, so the next attempt found nothing and the session's time was never billed or told to the host (`onCharge`). The ids a release finds are now kept across its attempts, handed on to a task that takes over from an aborted one, and used for the session's final charge, also when the release gives up and the session ends lost.
