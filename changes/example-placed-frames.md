---
packages: repo
kind: docs
---
New example `examples/placed-frames/` (`npm run demo:placed`): a pi agent draws a zoom into the Mandelbrot set, twelve frames, each one `frame` tool call that Jev places on a Daytona or a Modal sandbox, where it is drawn. Each answer names its sandbox by label and one line on why, composed from the placement record's fields, and the result card's rows cite the tool calls they count. With no key both sandboxes are local boxes, a scripted lead asks for the frames and a script stands in for Jev, and every answer says so; `--live` uses a Gemini key (or a gateway) for the agent and your own Daytona, Modal and TypeSafe accounts.
