---
packages: @parcha/pi-vision
kind: feature
---
A video read by a lead that takes images but not video now goes to eyes that take video as one clip with its sound (the file within the eyes' inline budget, or the `from_s..to_s` window), the same as for a lead that takes no images; the lead reads the eyes' answer in place of 8 frames. Frames stay for eyes that take no video and for a host with no eyes, and a lead that takes video still gets the video itself. For a host this is one eyes request per video read, filed and kept like any look: on a measured set it cost about $0.001 for an 8 s window, $0.005 for 60 s and $0.02 for 5 min at list price, where the lead's own 8 frames had cost $0.0002 to $0.006. When no such clip can be made, a file or window over the eyes' inline budget among them, this lead is shown its own 8 frames as before; a lead that takes no images still gets the `over_budget` miss that names a shorter window.
