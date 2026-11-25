---
packages: @parcha/agentrun-serve
kind: fix
---
A desktop's or a phone's live view draws its screen at your display's own pixels, so it stays sharp at any size, the console's full-window view and a high-density display included. The view used to draw each frame at the frame's size and let the browser stretch it to fit, which blurred text. A view whose box has the screen's shape is filled to its edges, and resizing it redraws the screen at the new size at once.
