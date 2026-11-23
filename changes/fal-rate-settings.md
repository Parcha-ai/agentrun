---
packages: @parcha/agentrun-serve
kind: fix
---
A fal job is priced under a spend cap only at the settings get_pricing's one rate is for. fal bills some endpoints at a rate that depends on a setting but get_pricing states one rate, so a job at a setting that costs more, or one that leaves out a setting whose default costs more, was held under what fal bills. Such a job is now refused unsent under a cap, and with no cap it runs booked as an unknown charge:
`fal-ai/ideogram/v3` (and its edit, remix, reframe and replace-background) is priced only with `"rendering_speed": "TURBO"`: BALANCED, the default, costs twice get_pricing's rate, and QUALITY three times. Send `TURBO`.
Veo 3.1 (`fal-ai/veo3.1`, its `fast` and `image-to-video`) is priced at 720p, the default, or 1080p, not at 4k.
`fal-ai/kling-video/v3/pro/image-to-video` is priced only with `"generate_audio": false`: audio on, the default, and voice control cost more than get_pricing's rate.
`fal-ai/sync-lipsync/v2` is priced for `lipsync-2`, the default, not `lipsync-2-pro`.
`fal-ai/nano-banana-pro` is priced at 1K, the default, or 2K, and without `enable_web_search`: 4K costs double, and a search costs more.
Fabric's resolution check (480p only) is the same rule and reads the same way.
