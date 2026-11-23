---
packages: @parcha/agentrun-serve
kind: fix
---
A fal job is priced at the rate its settings are billed at. fal bills some endpoints at a rate that depends on a setting but get_pricing states one rate, so a job at a setting that costs more, or one that leaves out a setting whose default costs more, was held, and booked, under what fal bills: an Ideogram v3 job with no `rendering_speed` renders at BALANCED and was held at half its price. Such a job is now held and booked at get_pricing's live rate times the ratio fal's model page gives its settings (read 2026-11-23), a setting it leaves out at its default, so a price change at fal moves every tier. A setting value the page names no rate for is refused unsent under a cap, and with no cap it runs booked as an unknown charge. An endpoint not listed here is priced at get_pricing's one rate, as before.
`fal-ai/ideogram/v3` (and its edit, remix, reframe and replace-background): TURBO ×1 (get_pricing's rate), BALANCED, the default, ×2, QUALITY ×3.
Veo 3.1 and its `image-to-video`: get_pricing's rate is 720p or 1080p with audio; audio off ×0.5, 4k with audio ×1.5, 4k without ×1. Veo 3.1 `fast`: audio off ×2/3, 4k with audio ×7/3, without ×2. Veo 3 `fast`: audio off ×2/3. Audio is on by default.
`fal-ai/kling-video/v3/pro/image-to-video`: get_pricing states $0.14 a second, the page $0.112 with audio off (×0.8), $0.168 with audio on, the default (×1.2), and $0.196 with voice control, an element with a `voice_id` (×1.4). Voice control with `"generate_audio": false` names no rate, so it is refused under a cap.
`fal-ai/sync-lipsync/v2`: `lipsync-2`, the default, ×1; `lipsync-2-pro` ×5/3.
`fal-ai/nano-banana-pro`: 1K, the default, or 2K ×1; 4K ×2; `enable_web_search` adds $0.015 a job.
`veed/fabric-1.0`: 480p ×1, 720p ×1.875 ($0.15 against $0.08). Before, a 720p job was refused under a cap; it is now priced. A job with no `resolution` is still refused: Fabric's resolution has no default.
ElevenLabs Music and dubbing are held, and booked, at their length rounded up to a whole minute, as fal bills them ("rounded up to the closest minute"): a 30 s track or a 4 s clip is a whole minute. Before, a 30 s track was held at half what fal bills.
