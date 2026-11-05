---
packages: @parcha/pi-browser
kind: fix
---
A browser session found by its tag (its create's answer was lost) is billed at its release even when the release is tried again. Before, a release that stopped the session but could not confirm it started its next attempt without the ids it had found, and a provider's tag lookup lists running sessions only, so the next attempt found nothing and the session's time was never billed or told to the host (`onCharge`). The ids a release finds are now kept across its attempts, handed on to a task that takes over from an aborted one, and used for the session's final charge, also when the release gives up and the session ends lost. The ids a lookup finds are kept even when the release that follows fails, since the stop may have landed before the provider's answer was lost. A reopen's reconcile that stops a lost session found by its tag and then fails keeps the id on the session's record, so the next reconcile releases and bills it.
