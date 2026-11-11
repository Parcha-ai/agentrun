---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
A phone computer now says its Android version, and a server with no adb says so. The deploy image carries adb from Android platform-tools r35.0.2 (amd64; the zip is pinned by sha256).
- The phone's hello carries `osVersion`, the Android release read with `getprop ro.build.version.release` at connect, beside the ABI. Once a run's computer is connected, the run's timeline has a phase row with what the computer says it is: `The phone is ready: Android 15 (arm64), from Phone harness.` A sandbox or desktop gets the same row, with its OS and architecture.
- A provider can declare a program it needs on the server's PATH: the module's `HOST_COMMAND`, repeated as `hostCommand` in the kind registry's entry. The phone's is adb. When it isn't on PATH at the server's start, Settings → Computers shows the provider as not ready with `adb isn't installed on this server (no adb command on PATH): install Android platform-tools, then restart AgentRun`, and the claim refuses it in those words. A run is refused at its start in those words too.
- The arm64 image has no adb, because Google builds platform-tools for x86-64 Linux only. On arm64, the phone provider shows as not ready, with those words.
