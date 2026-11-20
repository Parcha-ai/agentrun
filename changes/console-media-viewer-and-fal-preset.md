---
packages: @parcha/agentrun-serve
kind: feature
---
A run's images, videos and sounds now show in the console's file viewer instead of downloading: PNG, JPEG, GIF and WebP as an image, MP4 and WebM as a video with controls, MP3, WAV, M4A and Ogg as audio with controls. The viewer plays each from the run's file route and never reads it as text; Download saves that same file. The run files route now serves `.webm` (`video/webm`), `.mp3` (`audio/mpeg`), `.wav` (`audio/wav`), `.m4a` (`audio/mp4`) and `.ogg` (`audio/ogg`) with their types, inline, where it served them before as downloads with no type. SVG stays a download. **Settings → MCP servers** has a **fal (images, video, audio)** preset: fal's hosted MCP server (`https://mcp.fal.ai/mcp`) with your fal key as a bearer token, kept like any MCP server's credential and never in the box. A template that needs a `fal` URL server links to that form filled in.
