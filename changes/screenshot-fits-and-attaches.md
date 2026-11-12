---
packages: @parcha/pi-browser, @parcha/agentrun-serve
kind: breaking
---
`ScreenshotOptions.scale` (and `FakeScreenshotOptions.scale`) is a number, the fraction of the device-pixel capture to take, in place of `"css" | "device"`; a driver that passed `scale: "css"` passes `1 / devicePixelRatio`, and a custom `PageDriver.screenshot` honors a number below 1, else `captureWithinBudget` throws `ScreenshotBudgetError` for a capture over budget that it does not take smaller.

A screenshot over the 2,000 px long edge now shrinks to fit (CDP `clip.scale`) before its JPEG quality drops, so a long page on a device scale of 2 (stripe.com/pricing, a 2576x1248 viewport) comes back as a 1977x969 viewport in place of `ScreenshotBudgetError`; a full page whose fit would leave its short edge under 600 px is taken as the viewport, and the error is left for a browser that gives no capture that fits. On the runner, a screenshot's base64 is no longer cut to `[redacted]` by the run's key cut (which sent the model a `data:image/png;base64,[redacted]` URL and failed the run with a 400), and every image a model request carries is checked where it is attached: one with an unknown type, no data, data that is not base64, bytes of another type or a header that does not say its size goes as `[the image could not be attached: <why>]`.
