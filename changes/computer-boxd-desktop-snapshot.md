---
packages: @parcha/agentrun-computer
kind: feature
---
A boxd desktop starts from a snapshot that carries a desktop app. boxd's own image lists none of the stock apps (Xfce's text editor and terminal, xterm), so `apps.launch` had nothing to open there. boxd's `prepareImage()` now finds or builds `agentrun-desktop-<recipe hash>` once in the key's org: a build machine of boxd's own image, Xfce's text editor (mousepad) installed as root, the machine captured as a snapshot and deleted. The snapshot stays in the org as the image of every boxd desktop. A boxd desktop asked for on boxd's own image (`"default"`), or with `vcpu` and `memory` (a snapshot keeps the size it was captured at), is refused in words. A sandbox still starts from boxd's own image, with no call.
