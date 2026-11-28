---
packages: @parcha/agentrun-computer
kind: fix
---
boxd's desktop snapshot takes only `firefox-esr` from Mozilla's APT repository: the recipe pins `firefox-esr*` from packages.mozilla.org at 500 and every other package from that origin at -1, and writes the pin before the source, where it pinned every package from that origin at 1000 (which let it replace or downgrade any distro package). The recipe's hash moves, so the next boxd desktop start builds a new `agentrun-desktop-<12 hex>` snapshot; the old one stays in the org until it is deleted.
