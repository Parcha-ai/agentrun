---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: feature
---
A phone computer now says its Android version, and a server with no adb says so. The deploy image carries adb from Android platform-tools r35.0.2 (amd64; the zip is pinned by sha256).
- The phone's hello carries `osVersion`, the Android release read with `getprop ro.build.version.release` at connect, beside the ABI. Once a run's computer is connected, the run's timeline has a phase row with what the computer says it is: `The phone is ready: Android 15 (arm64), from Phone harness.` A sandbox or desktop gets the same row, with its OS and architecture.
- A provider descriptor can name a program it needs on the server's PATH (`hostCommand`: the command, what installs it, and the machines it is built for), and the kind registry's entry carries it. The phone's descriptor names adb. The server looks for it at its start. When it is missing, Settings → Computers shows the provider as not ready, the claim refuses it, and a run is refused at its start, all in the same words: `adb isn't installed on this server (no adb command on PATH): install Android platform-tools, then restart AgentRun`.
- On arm64 Linux, where Google builds no platform-tools and the arm64 image has none, the words say what the phone needs instead: `this server's image has no adb for arm64 (Android platform-tools has no Linux build for arm64): Phone harness needs an x86-64 server`.
