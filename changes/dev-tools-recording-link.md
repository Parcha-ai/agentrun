---
packages: @parcha/agentrun-serve
kind: feature
---
A call in the console's Dev tools tab and the recording made while it ran open each other. A tool call's details offer "Show on the recording" once the run is over and a finished recording has the call as a step: the Screen tab then plays that recording from the call's time. Under a recording's steps, "Open this step in Dev tools" opens the Dev tools tab on the details of the call the video is at; it is off, and says why, while that step is not a tool call. A step opens the very call it is, by its span, though another conversation made a call of the same id. A call past the trace's first 2,000 requests and calls opens no details, and the tab says so. Neither is offered where the run's trace can't be read.
