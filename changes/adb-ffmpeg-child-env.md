---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
The phone harness's adb and a run's screen recording's ffmpeg now start with only the environment names they read. Before, both got the server's whole environment, so a key the server held, under any name, reached them, and the adb server that a first adb call starts kept it for as long as it ran. adb now gets `BASE_ENV_NAMES` (PATH, HOME, TMPDIR, the locale) of the provider's `env`, which the phone harness descriptor's `hostEnv` names so serve hands them over. ffmpeg gets PATH, the locale and TMPDIR, as the server's other helper programs do.
